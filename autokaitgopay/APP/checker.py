import re
import os
import sys
import argparse
import asyncio
from playwright.async_api import async_playwright, TimeoutError

# Hindari UnicodeEncodeError pada terminal Windows/RDP dengan code page cp1252.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from logger import (
    C, progress, ProgressTracker,
    log_info, log_success, log_fail, log_warn, log_step, log_progress,
    print_config, print_summary, print_divider, task_label,
    BANNER_CHECKER
)

# File paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR)
INPUT_FILE = os.path.join(BASE_DIR, "GSUITETertautGoPay.txt")
CHECKED_FILE = os.path.join(BASE_DIR, "checked.txt")
EMPTY_FILE = os.path.join(BASE_DIR, "empty.txt")
HEADLESS = os.getenv("GOPAY_HEADLESS", "false").lower() == "true"

file_lock = asyncio.Lock()
checked_emails = set()  # Anti-duplikat: track emails yang sudah dicek

def load_already_checked():
    """Load akun sukses final. Akun empty boleh masuk batch retry berikutnya."""
    already = set()
    for filepath in [CHECKED_FILE]:
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and '|' in line:
                            email = line.split('|', 1)[0].strip().lower()
                            if email:
                                already.add(email)
            except Exception:
                pass
    return already

def read_accounts(file_path=None):
    # Resolve sesudah argumen CLI dipasang supaya tidak kembali ke file global lama.
    file_path = file_path or INPUT_FILE
    accounts = []
    if not os.path.exists(file_path):
        log_fail("SYS", f"File not found: {file_path}")
        return []
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and '|' in line:
                    email, password = line.split('|', 1)
                    email = email.strip()
                    password = password.strip()
                    if email and password:
                        accounts.append((email, password))
    except Exception as e:
        log_fail("SYS", f"Error reading file: {e}")
        return []
    if not accounts:
        log_fail("SYS", "No valid accounts found")
        return []
    return accounts

async def save_result(email, password, is_linked):
    output_file = CHECKED_FILE if is_linked else EMPTY_FILE
    async with file_lock:
        # Anti-duplikat: cek lagi sebelum save
        if email.lower() in checked_emails:
            return
        checked_emails.add(email.lower())
        with open(output_file, 'a', encoding='utf-8') as f:
            f.write(f"{email}|{password}\n")
        
        # Hapus dari GSUITETertautGoPay.txt setelah checked/empty
        try:
            if os.path.exists(INPUT_FILE):
                with open(INPUT_FILE, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
                remaining = [l for l in lines if l.strip().split('|', 1)[0].strip().lower() != email.lower()]
                with open(INPUT_FILE, 'w', encoding='utf-8') as f:
                    f.writelines(remaining)
                log_info("FILE", f"Removed {email} from GSUITETertautGoPay.txt")
        except Exception as e:
            log_warn("FILE", f"Could not remove from input: {e}")

async def check_account(playwright, email, password, semaphore, index, total):
    tid = task_label(index, email)
    browser = None
    context = None
    try:
        async with semaphore:
            progress.start_one()
            log_step(tid, "START", f"Checking {C.WHITE}{email}{C.RESET}")
            
            browser = await playwright.chromium.launch(
                headless=HEADLESS,
                args=[
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--disable-extensions',
                    '--disable-gpu',
                    '--disable-setuid-sandbox',
                    '--window-size=1280,720',
                    '--lang=id-ID',
                ]
            )
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 720},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                locale='id-ID',
                timezone_id='Asia/Jakarta',
            )
            page = await context.new_page()

            # Stealth: hide automation signals from Google
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
                window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
                Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
                Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            """)

            # === LOGIN ===
            log_step(tid, "LOGIN", "Opening Google Sign-in...")
            await page.goto("https://accounts.google.com/signin", timeout=60000)

            email_input = page.locator('input[type="email"]')
            await email_input.wait_for(state="visible", timeout=15000)
            await email_input.fill(email)
            await page.locator('#identifierNext button').click()
            log_info(tid, "Email entered")

            # Wait for password step to fully load
            await page.wait_for_selector('#passwordNext', state='visible', timeout=15000)
            pass_input = page.locator('#password input[type="password"]')
            await pass_input.wait_for(state="visible", timeout=10000)
            await pass_input.fill(password)
            await page.locator('#passwordNext button').click()
            log_info(tid, "Password entered")

            # Wait for login to process
            await asyncio.sleep(3)

            # Check for phone verification challenge
            current_url = page.url
            if 'challenge' in current_url or 'signin/rejected' in current_url:
                log_fail(tid, f"⚠️ Phone verification required - SKIPPING")
                progress.mark_failed()
                log_progress()
                return
            
            try:
                verify_page = page.locator('text=/Verify it|Verifikasi bahwa ini/i')
                phone_input = page.locator('input[type="tel"]')
                if await verify_page.count() > 0 or await phone_input.count() > 0:
                    log_fail(tid, f"⚠️ Phone verification required - SKIPPING")
                    progress.mark_failed()
                    log_progress()
                    return
            except:
                pass

            # === NAVIGATE TO PAYMENT METHODS (langsung tanpa tunggu myaccount) ===
            log_step(tid, "CHECK", "Navigating to Payment Methods...")
            await page.goto("https://play.google.com/store/paymentmethods?hl=id&pli=1", timeout=60000)
            await page.wait_for_load_state("domcontentloaded")

            # Wait for payment methods section to load
            try:
                await page.wait_for_selector('div.HgYqic', timeout=30000)
            except TimeoutError:
                log_fail(tid, "Payment page not loading")
                progress.mark_failed()
                await save_result(email, password, False)
                log_progress()
                return

            # === CHECK IF GOPAY IS LINKED ===
            is_linked = False
            gopay_linked = page.locator('div.HgYqic').filter(has_text=re.compile(r'GoPay:'))
            if await gopay_linked.count() > 0:
                is_linked = True
                log_success(tid, f"GoPay LINKED ✅ → checked.txt")
                progress.mark_success()
            else:
                log_fail(tid, f"GoPay NOT LINKED ❌ → empty.txt")
                progress.mark_failed()

            await save_result(email, password, is_linked)
            log_progress()

    except Exception as e:
        log_fail(tid, f"Error: {str(e)[:80]}")
        progress.mark_failed()
        # Jangan save_result untuk error — biar tetap di GSUITETertautGoPay.txt
        log_progress()
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()

def parse_args():
    parser = argparse.ArgumentParser(description="Check whether GoPay is linked")
    parser.add_argument("--input-file", default=INPUT_FILE)
    parser.add_argument("--checked-file", default=CHECKED_FILE)
    parser.add_argument("--empty-file", default=EMPTY_FILE)
    parser.add_argument("--browsers", type=int, default=None)
    parser.add_argument("--headless", action="store_true")
    return parser.parse_args()


async def main():
    global checked_emails, INPUT_FILE, CHECKED_FILE, EMPTY_FILE, HEADLESS
    args = parse_args()
    INPUT_FILE = os.path.abspath(args.input_file)
    CHECKED_FILE = os.path.abspath(args.checked_file)
    EMPTY_FILE = os.path.abspath(args.empty_file)
    HEADLESS = bool(args.headless or HEADLESS)
    for output_path in [INPUT_FILE, CHECKED_FILE, EMPTY_FILE]:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

    print(BANNER_CHECKER)
    
    accounts = read_accounts()
    if not accounts:
        if args.browsers is not None:
            raise RuntimeError(f"No valid GSuite accounts in {INPUT_FILE}")
        return

    # Anti-duplikat: load emails yang sudah dicek sebelumnya
    checked_emails = load_already_checked()
    skipped = 0
    if checked_emails:
        original_count = len(accounts)
        accounts = [(e, p) for e, p in accounts if e.lower() not in checked_emails]
        skipped = original_count - len(accounts)

    print_config({
        "📂 Input File": os.path.basename(INPUT_FILE),
        "📊 Total Accounts": str(len(accounts) + skipped),
        "⏭️  Skipped (duplikat)": str(skipped),
        "🔄 To Check": str(len(accounts)),
        "✅ Output Linked": os.path.basename(CHECKED_FILE),
        "❌ Output Empty": os.path.basename(EMPTY_FILE),
    })
    print()

    if not accounts:
        log_success("SYS", "Semua akun sudah dicek sebelumnya! Tidak ada yang perlu dicek.")
        return

    max_browsers = max(1, min(3, int(args.browsers))) if args.browsers is not None else int(input(f"  {C.YELLOW}?{C.RESET}  Jumlah browser paralel (default 3): ").strip() or "3")
    
    print_config({
        "🖥️  Parallel": f"{max_browsers} browsers",
        "🔒 Mode": "Headless" if HEADLESS else "Visible",
    })

    progress.total = len(accounts)
    print_divider("STARTING CHECKER", C.CYAN)
    print()

    async with async_playwright() as playwright:
        semaphore = asyncio.Semaphore(max_browsers)
        tasks = []
        for index, (email, password) in enumerate(accounts):
            task = asyncio.create_task(
                check_account(playwright, email, password, semaphore, index, len(accounts))
            )
            tasks.append(task)

        await asyncio.gather(*tasks, return_exceptions=True)

    # Summary
    checked_count = 0
    empty_count = 0
    if os.path.exists(CHECKED_FILE):
        with open(CHECKED_FILE, 'r') as f:
            checked_count = sum(1 for line in f if line.strip())
    if os.path.exists(EMPTY_FILE):
        with open(EMPTY_FILE, 'r') as f:
            empty_count = sum(1 for line in f if line.strip())

    print_summary("CHECKER RESULTS", {
        "GoPay Linked (checked.txt)": (str(checked_count), C.GREEN),
        "GoPay Empty (empty.txt)": (str(empty_count), C.RED),
        "Total Processed": (str(checked_count + empty_count), C.WHITE),
    })

if __name__ == "__main__":
    asyncio.run(main())
