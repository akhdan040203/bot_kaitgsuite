import re
import os
import sys
import argparse
import requests
import asyncio
from dotenv import load_dotenv
from playwright.async_api import async_playwright, TimeoutError, Page

# Terminal Windows/RDP sering memakai cp1252. Logger aplikasi berisi simbol Unicode,
# jadi paksa stream UTF-8 sebelum Colorama membungkus stdout/stderr.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from logger import (
    C, progress, ProgressTracker,
    log_info, log_success, log_fail, log_warn, log_step, log_otp, log_lock, log_unlock,
    log_progress, print_config, print_summary, print_divider, task_label,
    BANNER_CONNECT
)

# Resolve every data/config file from the package root.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR)
load_dotenv(os.path.join(BASE_DIR, ".env"))

r = requests.Session()

# File paths
CREDENTIALS_FILE = os.path.join(BASE_DIR, "Gsuite.txt")
SUCCESS_FILE = os.path.join(BASE_DIR, "GSUITETertautGoPay.txt")
FAILURE_FILE = os.path.join(BASE_DIR, "GsuiteKosongan.txt")
HEADLESS = os.getenv("GOPAY_HEADLESS", "false").lower() == "true"

# GoPay credentials from .env
GOPAY_PHONE = os.getenv("GOPAY_PHONE", "")
GOPAY_PIN = os.getenv("GOPAY_PIN", "")

# Async lock for file operations
file_lock = asyncio.Lock()

async def update_credentials_file(credentials_list, processed_email, password, is_success=False):
    try:
        if is_success:
            # Remove from Gsuite.txt and add to GSUITETertautGoPay.txt
            credentials_list = [cred for cred in credentials_list if cred[0] != processed_email]
            with open(CREDENTIALS_FILE, 'w', encoding='utf-8') as file:
                for email, pwd in credentials_list:
                    file.write(f"{email}|{pwd}\n")
            with open(SUCCESS_FILE, 'a', encoding='utf-8') as file:
                file.write(f"{processed_email}|{password}\n")
            log_info("FILE", f"Saved {processed_email} → {SUCCESS_FILE}")
            log_info("FILE", f"{len(credentials_list)} accounts remaining")
        else:
            # Keep in Gsuite.txt for retry - don't remove
            log_info("FILE", f"{processed_email} kept for retry")
    except Exception as e:
        log_fail("FILE", f"Error updating credentials: {str(e)[:60]}")
        raise
    return credentials_list

def read_credentials(file_path=None):
    # Default argument Python dievaluasi saat fungsi dibuat. Resolve di runtime agar
    # path dari --input-file milik order benar-benar digunakan.
    file_path = file_path or CREDENTIALS_FILE
    credentials = []
    if not os.path.exists(file_path):
        log_fail("SYS", f"Gsuite.txt not found at {file_path}")
        return []
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            for line in file:
                line = line.strip()
                if line and '|' in line:
                    email, password = line.split('|', 1)
                    email = email.strip()
                    password = password.strip()
                    if email and password:
                        credentials.append((email, password))
    except Exception as e:
        log_fail("SYS", f"Error reading Gsuite.txt: {str(e)[:60]}")
        return []
    if not credentials:
        log_fail("SYS", "Gsuite.txt has no valid email|password entries")
        return []
    return credentials

async def wait_for_element(page_or_frame, selector, state="visible", timeout=10000):
    try:
        if isinstance(page_or_frame, Page):
            await page_or_frame.wait_for_selector(selector, state=state, timeout=timeout)
        else:
            raise TypeError(f"Unsupported type {type(page_or_frame)}")
    except TimeoutError as e:
        log_fail("SYS", f"Timeout waiting for {selector}")
        raise


async def click_gopay_continue(page, task_id):
    """Klik tombol persetujuan pada variasi UI Google Payments/RDP."""
    label_re = re.compile(r"Lanjutkan(?:\s+ke)?\s+GoPay|Continue(?:\s+to)?\s+GoPay", re.IGNORECASE)
    last_error = None
    # Poll singkat agar tidak menunggu timeout berulang untuk setiap selector/frame.
    for _ in range(30):
        frames = list(page.frames)
        frames.sort(key=lambda frame: 0 if frame.name == "hnyNZeIframe" else 1)
        for frame in frames:
            candidates = [
                frame.get_by_text(label_re),
                frame.get_by_role("button", name=label_re),
                frame.locator('button, [role="button"]').filter(has_text=label_re),
                frame.locator('div[role="button"].submit-button, button.submit-button'),
            ]
            for candidate in candidates:
                try:
                    if await candidate.count() == 0:
                        continue
                    button = candidate.first
                    if not await button.is_visible():
                        continue
                    try:
                        await button.click(force=True, timeout=3000)
                    except Exception:
                        # Beberapa versi Google menaruh teks pada child element; DOM click
                        # tetap memicu handler pada parent lewat event bubbling.
                        await button.evaluate("element => element.click()")
                    log_info(task_id, "Clicked 'Lanjutkan ke GoPay'")
                    return
                except Exception as exc:
                    last_error = exc
        await asyncio.sleep(0.5)
    raise RuntimeError(f"Tombol 'Lanjutkan ke GoPay' tidak ditemukan: {last_error}")

async def process_account(playwright, email, password, semaphore, otp_lock, index):
    global credentials_list_global
    browser = None
    context = None
    page = None
    try:
        async with semaphore:
            tid = task_label(index, email)
            progress.start_one()
            log_step(tid, "START", f"Starting automation for {C.WHITE}{email}{C.RESET}")
            browser = await playwright.chromium.launch(
                headless=HEADLESS,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--window-size=1280,720",
                    "--lang=id-ID",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-infobars",
                    "--disable-extensions",
                    "--disable-gpu",
                    "--disable-setuid-sandbox",
                ]
            )
            context = await browser.new_context(
                viewport={"width": 1280, "height": 720},
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

            # === LOGIN GSUITE ===
            log_step(tid, "LOGIN", "Opening Google Sign-in...")
            await page.goto("https://accounts.google.com/signin", timeout=60000)
            await wait_for_element(page, 'input[type="text"]')
            await page.fill('input[type="text"]', email)
            try:
                await page.click('#identifierNext')
                log_info(tid, "Email entered")
            except Exception as e:
                log_fail(tid, f"Failed to click Next: {str(e)[:60]}")
                async with file_lock:
                    credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                progress.mark_failed()
                log_progress()
                return

            await wait_for_element(page, 'input[type="password"]', timeout=30000)
            await page.fill('input[type="password"]', password)
            try:
                await page.click('#passwordNext')
                log_info(tid, "Password entered")
            except Exception as e:
                log_fail(tid, f"Failed password step: {str(e)[:60]}")
                async with file_lock:
                    credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                progress.mark_failed()
                log_progress()
                return

            try:
                await page.get_by_role("button", name="Saya mengerti").click(timeout=8000)
            except:
                pass

            # Check for phone verification challenge
            try:
                verify_page = page.locator('text=/Verify it|Verifikasi bahwa ini/i')
                phone_input = page.locator('input[type="tel"]')
                myaccount = page.locator('text=myaccount.google.com').or_(page.locator('body'))
                
                # Wait briefly for verification page indicators
                await asyncio.sleep(3)
                current_url = page.url
                
                if 'challenge' in current_url or 'signin/rejected' in current_url:
                    log_fail(tid, f"⚠️ Phone verification required - SKIPPING")
                    async with file_lock:
                        credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                    progress.mark_failed()
                    log_progress()
                    return
                
                if await verify_page.count() > 0 or await phone_input.count() > 0:
                    log_fail(tid, f"⚠️ Phone verification required - SKIPPING")
                    async with file_lock:
                        credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                    progress.mark_failed()
                    log_progress()
                    return
            except:
                pass

            try:
                await page.wait_for_url(re.compile("myaccount.google.com"), timeout=60000)
                log_info(tid, "Logged in successfully")
            except TimeoutError:
                log_warn(tid, "Navigation timeout, proceeding...")

            # === NAVIGATE TO PAYMENT METHODS ===
            log_step(tid, "PAYMENT", "Checking payment methods...")
            await page.goto("https://play.google.com/store/paymentmethods?hl=id", timeout=60000)
            await page.wait_for_load_state("domcontentloaded")

            # Race: check for existing GoPay OR "Tambahkan GoPay" button
            existing_gopay = page.locator('div.HgYqic').filter(has_text=re.compile(r'GoPay:'))
            tambahkan_gopay = page.locator('div.HgYqic').filter(has_text="Tambahkan GoPay")
            
            # Wait for either element to appear
            try:
                await page.wait_for_selector('div.HgYqic', timeout=30000)
            except TimeoutError:
                log_fail(tid, "Payment methods page not loading")
                async with file_lock:
                    credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                progress.mark_failed()
                log_progress()
                return

            # Check which element appeared
            if await existing_gopay.count() > 0:
                log_success(tid, "GoPay already linked! Skipping...")
                async with file_lock:
                    credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=True)
                progress.mark_success()
                log_progress()
                return

            if await tambahkan_gopay.count() == 0:
                log_fail(tid, "No 'Tambahkan GoPay' button found")
                async with file_lock:
                    credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                progress.mark_failed()
                log_progress()
                return

            # === CLICK "Tambahkan GoPay" (with retry on timeout) ===
            MAX_GOPAY_RETRIES = 2
            gopay_success = False
            
            for gopay_retry in range(1, MAX_GOPAY_RETRIES + 1):
              log_step(tid, "GOPAY", f"Clicking 'Tambahkan GoPay'... (attempt {gopay_retry}/{MAX_GOPAY_RETRIES})")
              try:
                # Re-locate button (needed on retry after Batal)
                tambahkan_gopay = page.locator('div.HgYqic').filter(has_text="Tambahkan GoPay")
                await tambahkan_gopay.first.wait_for(state="visible", timeout=15000)
                await tambahkan_gopay.first.click()
                log_info(tid, "Clicked 'Tambahkan GoPay'")

                # Wait for iframe to appear
                await page.wait_for_selector('iframe[name="hnyNZeIframe"]', state="attached", timeout=15000)

                # Klik variasi tombol: "Lanjutkan", "Lanjutkan ke GoPay", atau English UI.
                try:
                    await click_gopay_continue(page, tid)
                    
                    # Cari tab GoPay dengan polling. Event popup bisa sudah terjadi tepat
                    # saat click sehingga wait_for_event setelah click dapat terlewat.
                    gopay_page = None
                    all_pages = []
                    for _ in range(60):
                        all_pages = context.pages
                        for p in all_pages:
                            page_url = p.url
                            if p != page and ("gopayapi.com" in page_url or "gopay" in page_url.lower()):
                                gopay_page = p
                                break
                        if gopay_page is not None or len(all_pages) > 1:
                            break
                        await asyncio.sleep(0.5)
                    
                    if gopay_page is None and len(all_pages) > 1:
                        gopay_page = all_pages[-1]
                    
                    if gopay_page is None or gopay_page == page:
                        log_fail(tid, "GoPay window not found")
                        async with file_lock:
                            credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                        progress.mark_failed()
                        log_progress()
                        return
                    
                    await gopay_page.bring_to_front()
                    await gopay_page.wait_for_load_state("networkidle", timeout=30000)
                    
                    frames = gopay_page.frames
                    
                    # === ACQUIRE OTP LOCK ===
                    log_lock(tid, "Waiting for OTP lock...")
                    await otp_lock.acquire()
                    otp_lock_held = True
                    log_lock(tid, "OTP lock acquired")

                    try:
                      phone_local = GOPAY_PHONE
                      if phone_local.startswith("62"):
                          phone_local = phone_local[2:]
                      elif phone_local.startswith("+62"):
                          phone_local = phone_local[3:]
                    
                      log_step(tid, "PHONE", f"Filling phone: {phone_local}")
                    
                      # Find the fulfil frame
                      gopay_frame = None
                      for frame in frames:
                          if "fulfil" in frame.url or "authorize" in frame.url:
                              frame_content = await frame.content()
                              if "phone-number-input" in frame_content:
                                  gopay_frame = frame
                                  break
                      
                      if gopay_frame is None:
                          gopay_frame = gopay_page
                      
                      phone_input = gopay_frame.locator('#phone-number-input')
                      await phone_input.wait_for(state="visible", timeout=10000)
                      await phone_input.click()
                      await phone_input.press("Control+a")
                      await phone_input.press("Backspace")
                      await phone_input.type(phone_local, delay=100)
                      log_info(tid, f"Phone typed: {phone_local}")
                      
                      await asyncio.sleep(1)  # Brief wait for validation
                      
                      submit_btn = gopay_frame.locator('#submit')
                      await submit_btn.wait_for(state="visible", timeout=5000)
                      is_disabled = await submit_btn.is_disabled()
                      if is_disabled:
                          await gopay_frame.evaluate('document.querySelector("#submit").removeAttribute("disabled")')
                      await submit_btn.click()
                      log_info(tid, "Clicked 'Continue'")
                      
                      # Wait for OTP page to load
                      await gopay_page.wait_for_load_state("networkidle", timeout=30000)
                      
                      # === OTP HANDLING (webhook + auto-resend) ===
                      OTP_WEBHOOK = os.getenv("OTP_WEBHOOK_URL", "http://103.94.239.36:3089")
                      MAX_OTP_ATTEMPTS = 3
                      OTP_WAIT_SECONDS = 60
                      
                      otp_code = None
                      for otp_attempt in range(1, MAX_OTP_ATTEMPTS + 1):
                          log_otp(tid, f"Waiting for OTP from webhook (attempt {otp_attempt}/{MAX_OTP_ATTEMPTS}, {OTP_WAIT_SECONDS}s)...")
                          try:
                              resp = await asyncio.get_event_loop().run_in_executor(
                                  None, lambda: requests.get(f"{OTP_WEBHOOK}/otp/wait/{OTP_WAIT_SECONDS}", timeout=OTP_WAIT_SECONDS + 10)
                              )
                              data = resp.json()
                              if data.get("success") and data.get("otp"):
                                  otp_code = data["otp"]
                                  log_otp(tid, f"OTP received: {C.BOLD}{otp_code}{C.RESET}")
                                  break
                              else:
                                  log_warn(tid, f"No OTP after {OTP_WAIT_SECONDS}s")
                          except Exception as e:
                              log_warn(tid, f"Webhook error: {e}")
                          
                          # Auto-resend OTP if not the last attempt
                          if otp_attempt < MAX_OTP_ATTEMPTS:
                              log_otp(tid, "Auto-resend OTP...")
                              try:
                                  resend_frame = None
                                  for frame in gopay_page.frames:
                                      fc = await frame.content()
                                      if "resend-otp" in fc:
                                          resend_frame = frame
                                          break
                                  if resend_frame is None:
                                      resend_frame = gopay_frame
                                  
                                  await resend_frame.evaluate('''() => {
                                      const btn = document.querySelector('#resend-otp button[value="resend-otp"]');
                                      if (btn) {
                                          btn.removeAttribute("disabled");
                                          btn.click();
                                      }
                                  }''')
                                  log_otp(tid, "Resend OTP clicked ✓")
                                  await asyncio.sleep(5)
                              except Exception as resend_err:
                                  log_warn(tid, f"Resend error: {str(resend_err)[:60]}")
                          else:
                              log_fail(tid, f"OTP gagal setelah {MAX_OTP_ATTEMPTS}x percobaan")
                      
                      if otp_code and len(otp_code) == 6:
                          otp_frame = None
                          for frame in gopay_page.frames:
                              fc = await frame.content()
                              if "firstInput" in fc or "validate-otp" in fc:
                                  otp_frame = frame
                                  break
                          if otp_frame is None:
                              otp_frame = gopay_frame
                          
                          otp_input = otp_frame.locator('#firstInput')
                          await otp_input.wait_for(state="visible", timeout=10000)
                          await otp_input.click()
                          await otp_input.type(otp_code, delay=100)
                          log_otp(tid, f"Typed OTP: {otp_code}")
                          
                          confirm_btn = otp_frame.locator('button[value="validate-otp"]')
                          is_disabled = await confirm_btn.is_disabled()
                          if is_disabled:
                              await otp_frame.evaluate('document.querySelector(\'button[value="validate-otp"]\').removeAttribute("disabled")')
                          await confirm_btn.click()
                          log_otp(tid, "OTP confirmed ✓")
                          
                          # === PIN HANDLING (wait for PIN page) ===
                          log_step(tid, "PIN", "Waiting for PIN page...")
                          try:
                              pin_frame = None
                              for frame in gopay_page.frames:
                                  fc = await frame.content()
                                  if "validate-pin" in fc or "input pin" in fc.lower():
                                      pin_frame = frame
                                      break
                              if pin_frame is None:
                                  pin_frame = gopay_frame
                              
                              pin_input = pin_frame.locator('input.pin')
                              await pin_input.wait_for(state="visible", timeout=15000)
                              await pin_input.click()
                              await pin_input.type(GOPAY_PIN, delay=100)
                              log_info(tid, "PIN entered")
                              
                              pin_confirm = pin_frame.locator('button[value="validate-pin"]')
                              is_disabled = await pin_confirm.is_disabled()
                              if is_disabled:
                                  await pin_frame.evaluate('document.querySelector(\'button[value="validate-pin"]\').removeAttribute("disabled")')
                              await pin_confirm.click()
                              log_info(tid, "PIN confirmed ✓")
                              
                              # === CHECK FOR "TIME'S UP" ERROR ===
                              await asyncio.sleep(3)
                              times_up = False
                              try:
                                  for frame in gopay_page.frames:
                                      fc = await frame.content()
                                      if "time" in fc.lower() and "up" in fc.lower() and "errorMapping" in fc:
                                          times_up = True
                                          break
                                  if not times_up:
                                      # Also check main gopay page
                                      gp_content = await gopay_page.content()
                                      if "time" in gp_content.lower() and "up" in gp_content.lower() and "errorMapping" in gp_content:
                                          times_up = True
                              except:
                                  pass
                              
                              if times_up:
                                  log_warn(tid, "⏰ GoPay 'Time's up' detected! Retrying...")
                                  # Close GoPay page
                                  try:
                                      await gopay_page.close()
                                  except:
                                      pass
                                  
                                  # Release OTP lock for retry
                                  if otp_lock_held:
                                      otp_lock.release()
                                      otp_lock_held = False
                                  
                                  # Wait and click Batal if visible
                                  await asyncio.sleep(2)
                                  try:
                                      batal_btn = page.locator('button:has-text("Batal"), div[role="button"]:has-text("Batal")')
                                      if await batal_btn.count() > 0:
                                          await batal_btn.first.click()
                                          log_info(tid, "Clicked 'Batal'")
                                          await asyncio.sleep(2)
                                  except:
                                      pass
                                  
                                  # Check if we can retry
                                  if gopay_retry < MAX_GOPAY_RETRIES:
                                      log_info(tid, f"Retrying GoPay flow (attempt {gopay_retry + 1}/{MAX_GOPAY_RETRIES})...")
                                      continue  # Go to next iteration of retry loop
                                  else:
                                      log_fail(tid, "GoPay time's up after all retries")
                                      progress.mark_failed()
                                      async with file_lock:
                                          credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                                      break
                              
                              # === NO ERROR → PROCEED TO SIMPAN ===
                              # Wait for GoPay popup to close
                              await page.wait_for_selector('iframe[name="hnyNZeIframe"]', state="attached", timeout=30000)
                              
                              # === CLICK "Simpan" ===
                              log_step(tid, "SAVE", "Clicking 'Simpan'...")
                              try:
                                  iframe = page.frame_locator('iframe[name="hnyNZeIframe"]')
                                  simpan_button = iframe.locator('div[role="button"].submit-button')
                                  await simpan_button.wait_for(state="visible", timeout=20000)
                                  await simpan_button.click()
                                  log_info(tid, "Clicked 'Simpan'")
                                  
                                  # Verify: wait for GoPay element to appear after section reload
                                  try:
                                      gopay_verify = page.locator('div.HgYqic').filter(has_text=re.compile(r'GoPay:'))
                                      await gopay_verify.first.wait_for(state="visible", timeout=30000)
                                      log_success(tid, f"GoPay linked and verified! ✅")
                                      gopay_success = True
                                      progress.mark_success()
                                      async with file_lock:
                                          credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=True)
                                  except:
                                      log_warn(tid, "Could not verify, but Simpan clicked")
                                      gopay_success = True
                                      progress.mark_success()
                                      async with file_lock:
                                          credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=True)
                                      
                              except Exception as simpan_err:
                                  log_fail(tid, f"Simpan failed: {str(simpan_err)[:60]}")
                                  progress.mark_failed()
                                  async with file_lock:
                                      credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                              
                          except Exception as pin_err:
                              log_fail(tid, f"PIN failed: {str(pin_err)[:60]}")
                              progress.mark_failed()
                              async with file_lock:
                                  credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                      else:
                          log_fail(tid, "Invalid OTP (must be 6 digits)")
                          progress.mark_failed()
                          async with file_lock:
                              credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
                    finally:
                      if otp_lock_held:
                          otp_lock.release()
                          otp_lock_held = False
                          log_unlock(tid, "Lock released (cleanup)")
                    
                except Exception as e:
                    log_fail(tid, f"GoPay error: {str(e)[:80]}")
                    progress.mark_failed()
                    async with file_lock:
                        credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)

              except TimeoutError:
                log_fail(tid, "'Tambahkan GoPay' button not found")
                progress.mark_failed()
                async with file_lock:
                    credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
              
              # Break loop if we succeeded or failed (not retrying)
              if gopay_success or gopay_retry >= MAX_GOPAY_RETRIES:
                  break

    except Exception as e:
        log_fail(f"T{index}", f"Critical error for {email}: {str(e)[:80]}")
        progress.mark_failed()
        async with file_lock:
            credentials_list_global = await update_credentials_file(credentials_list_global, email, password, is_success=False)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        log_progress()

async def connect_gsuite_to_gopay(playwright, credentials_list, max_browsers):
    global credentials_list_global
    credentials_list_global = credentials_list.copy()

    if not credentials_list_global:
        log_fail("SYS", "No Gsuite credentials available")
        return

    if not GOPAY_PHONE:
        raise RuntimeError("GOPAY_PHONE is not set in .env file")
    if not GOPAY_PIN:
        raise RuntimeError("GOPAY_PIN is not set in .env file")

    progress.total = len(credentials_list_global)

    semaphore = asyncio.Semaphore(max_browsers)
    otp_lock = asyncio.Lock()
    tasks = []
    for index, (email, password) in enumerate(credentials_list_global):
        task = asyncio.create_task(
            process_account(playwright, email, password, semaphore, otp_lock, index)
        )
        tasks.append(task)

    print_divider("STARTING AUTOMATION", C.CYAN)
    print()
    await asyncio.gather(*tasks, return_exceptions=True)

    print_summary("AUTOMATION RESULTS", {
        "Successfully Linked": (str(progress.success), C.GREEN),
        "Failed": (str(progress.failed), C.RED),
        "Total Processed": (str(progress.done), C.WHITE),
    })

def get_max_browsers(configured=None):
    if configured is not None:
        return max(1, min(3, int(configured)))
    while True:
        try:
            max_browsers = int(input(f"  {C.YELLOW}?{C.RESET}  Jumlah browser paralel (1-3): ").strip())
            if 1 <= max_browsers <= 3:
                return max_browsers
            else:
                log_fail("SYS", "Enter a number between 1 and 3")
        except ValueError:
            log_fail("SYS", "Invalid input")

def parse_args():
    parser = argparse.ArgumentParser(description="Connect GSuite accounts to GoPay")
    parser.add_argument("--input-file", default=CREDENTIALS_FILE)
    parser.add_argument("--success-file", default=SUCCESS_FILE)
    parser.add_argument("--failure-file", default=FAILURE_FILE)
    parser.add_argument("--browsers", type=int, default=None)
    parser.add_argument("--headless", action="store_true")
    return parser.parse_args()


async def main():
    global CREDENTIALS_FILE, SUCCESS_FILE, FAILURE_FILE, HEADLESS
    args = parse_args()
    CREDENTIALS_FILE = os.path.abspath(args.input_file)
    SUCCESS_FILE = os.path.abspath(args.success_file)
    FAILURE_FILE = os.path.abspath(args.failure_file)
    HEADLESS = bool(args.headless or HEADLESS)
    for output_path in [CREDENTIALS_FILE, SUCCESS_FILE, FAILURE_FILE]:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

    print(BANNER_CONNECT)

    credentials_list = read_credentials()
    if not credentials_list:
        if args.browsers is not None:
            raise RuntimeError(f"No valid GSuite accounts in {CREDENTIALS_FILE}")
        return

    if not GOPAY_PHONE:
        raise RuntimeError("GOPAY_PHONE is not set in .env file")
    if not GOPAY_PIN:
        raise RuntimeError("GOPAY_PIN is not set in .env file")

    print_config({
        "📂 Credentials": f"{os.path.basename(CREDENTIALS_FILE)} ({len(credentials_list)} accounts)",
        "📱 GoPay Phone": GOPAY_PHONE,
        "🔑 GoPay PIN": "●" * len(GOPAY_PIN) if GOPAY_PIN else "NOT SET",
        "✅ Success File": os.path.basename(SUCCESS_FILE),
        "❌ Failure File": os.path.basename(FAILURE_FILE),
    })
    print()

    async with async_playwright() as playwright:
        max_browsers = get_max_browsers(args.browsers)
        print_config({
            "🖥️  Parallel": f"{max_browsers} browsers",
            "🔒 Mode": "Headless" if HEADLESS else "Visible",
            "🔐 OTP Lock": "Enabled (phone→OTP only)",
        })
        print()
        await connect_gsuite_to_gopay(playwright, credentials_list, max_browsers)

if __name__ == "__main__":
    asyncio.run(main())
