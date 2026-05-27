import uiautomator2 as u2
import time
from datetime import datetime
import threading
from queue import Queue, Empty
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv
import re
import argparse

INPUT_FILE = "gsuite.txt"
RESULT_FILE = "Hasil-Gdoku.txt"

class EmulatorAutomator:
    def __init__(self, port, name):
        self.port = port
        self.name = name
        self.device = None
        self.email_queue = Queue()
        self.doku_queue = Queue()
        self.used_doku_lock = threading.Lock()
        self.result_file_lock = threading.Lock()  # Lock untuk file hasil
        
    def log_info(self, message):
        safe_message = str(message).encode("ascii", "replace").decode("ascii")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] INFO: {safe_message}")

    def log_warn(self, message):
        safe_message = str(message).encode("ascii", "replace").decode("ascii")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] WARNING: {safe_message}")

    def log_error(self, message):
        safe_message = str(message).encode("ascii", "replace").decode("ascii")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] ERROR: {safe_message}")

    def connect(self):
        try:
            self.log_info(f"Connecting to emulator at 127.0.0.1:{self.port}...")
            self.device = u2.connect(f"127.0.0.1:{self.port}")
            # Reduce timeout for faster response
            self.device.settings['wait_timeout'] = 10
            self.device.settings['operation_delay'] = (0, 0.5)  # Reduce delay between operations
            self.log_info("Successfully connected to emulator.")
            return True
        except Exception as e:
            self.log_error(f"Failed to connect to emulator: {e}")
            return False

    def fast_click_text(self, text_list, timeout=2):
        """Optimized text clicking with reduced timeout"""
        for text in text_list:
            if self.device(textMatches="(?i)" + text).click_exists(timeout=timeout):
                return True
        return False

    def fast_handle_popups(self):
        """Optimized popup handling with concurrent checking"""
        self.log_info("Checking for popups...")
        
        popup_elements = [
            ("Meet the Search tab", lambda: self.device.click(100, 100)),
            ("Got it", lambda: self.device(text="Got it").click()),
            ("No thanks", lambda: self.device(text="No thanks").click()),
            ("Skip", lambda: self.device(text="Skip").click()),
            ("Not now", lambda: self.device(text="Not now").click()),
            ("Maybe later", lambda: self.device(text="Maybe later").click()),
            ("Close", lambda: self.device(text="Close").click())
        ]
        
        for text, action in popup_elements:
            if self.device(text=text).exists(timeout=1):
                self.log_info(f"Found popup '{text}', handling...")
                action()
                time.sleep(0.5)  # Reduced sleep time
                break
        
        self.log_info("Popup check completed")

    def fast_remove_google_account(self, email):
        """Optimized account removal with reduced waits"""
        try:
            self.log_info(f"====== STARTING ACCOUNT REMOVAL ======")
            self.log_info(f"Target email: {email}")
            
            # Quick app start
            self.device.app_start("com.android.settings")
            time.sleep(1)  # Reduced from 2
            
            # Fast navigation to Passwords & accounts
            if not self.device(text="Passwords & accounts").click_exists(timeout=3):
                self.device(scrollable=True).scroll.to(text="Passwords & accounts")
                if not self.device(text="Passwords & accounts").click_exists(timeout=2):
                    self.log_error(f"Cannot find Passwords & accounts menu")
                    return False

            time.sleep(1)  # Reduced from 2
            
            # Quick email account search and click
            if not self.device(text=f"{email}").click_exists(timeout=5):
                self.device(scrollable=True).scroll.to(text=f"{email}")
                if not self.device(text=f"{email}").click_exists(timeout=3):
                    self.log_error(f"Cannot find account {email}")
                    return False
            
            time.sleep(1)  # Reduced from 2

            # Fast remove account
            remove_texts = ["REMOVE ACCOUNT", "Remove account", "Hapus akun", "HAPUS AKUN"]
            removed = False
            
            for text in remove_texts:
                if self.device(text=text).click_exists(timeout=2):
                    self.log_info(f"Clicked '{text}'")
                    time.sleep(0.5)
                    # Double confirmation
                    self.device(text=text).click_exists(timeout=2)
                    removed = True
                    break

            if not removed:
                self.log_error(f"Cannot find Remove Account button")
                return False

            time.sleep(2)  # Reduced from 3
            
            # Quick verification
            if self.device(text=f"{email}").exists(timeout=3):
                self.log_error(f"Account {email} still detected after removal")
                return False
            
            self.log_info(f"Account {email} successfully removed")
            return True
            
        except Exception as e:
            self.log_error(f"Error removing account {email}: {e}")
            return False

    def fast_process_account(self, email, password, psc_email, psc_pass):
        try:
            self.log_info(f"====== STARTING NEW ACCOUNT PROCESS ======")
            self.log_info(f"Email: {email}, Paysafecard: {psc_email}")
            
            # Quick home and settings
            self.device.press("home")
            time.sleep(0.5)  # Reduced from 1
            
            self.device.app_start("com.android.settings")
            time.sleep(1)  # Reduced from 2

            # Fast navigation
            self.device(scrollable=True).scroll.to(text="Passwords & accounts")
            self.device(text="Passwords & accounts").click()
            time.sleep(1)  # Reduced from 2
            
            # Quick Google account addition
            self.device(text="Add account").click()
            time.sleep(1)  # Reduced from 2
            self.device(text="Google").click()
            time.sleep(3)  # Reduced from 5
            
            # Fast email input
            self.device(className="android.widget.EditText").set_text(email)
            time.sleep(0.5)  # Reduced from 1
            
            self.fast_click_text(["NEXT", "Next", "Berikutnya", "BERIKUTNYA"])
            time.sleep(2)  # Reduced from 3

            # Wait for password form
            self.device(text="Add PaysafeCard").exists(timeout=8)  # Reduced from 10
            
            # Fast password input
            self.device(className="android.widget.EditText").set_text(password)
            time.sleep(2)  # Reduced from 3
            
            self.fast_click_text(["NEXT", "Next", "Berikutnya", "BERIKUTNYA"])
            time.sleep(3)  # Reduced from 3

            # Handle confirmations quickly
            confirmation_buttons = [
                ("I UNDERSTAND", 10),
                ("I agree", 10),
                ("MORE", 10),
                ("ACCEPT", 10)
            ]
            
            for button_text, timeout in confirmation_buttons:
                if self.device(textMatches=f"(?i){button_text}").click_exists(timeout=timeout):
                    self.log_info(f"Clicked {button_text}")
                    time.sleep(1)  # Reduced from 2

            # Quick Play Store launch
            self.device.press("home")
            self.device.app_start("com.android.vending")
            time.sleep(5)  # Reduced from 5

            # Fast popup handling
            self.fast_handle_popups()

            # Optimized account clicking with multiple strategies
            account_clicked = False
            click_strategies = [
                lambda: self.device(descriptionContains="Account").click_exists(timeout=2),
                lambda: self.device(resourceId="com.android.vending:id/account_menu_item").click_exists(timeout=2),
                lambda: (self.device.click(450, 100), True)[1]  # Coordinate fallback
            ]
            
            for i, strategy in enumerate(click_strategies):
                try:
                    if strategy():
                        self.log_info(f"Account clicked using strategy {i+1}")
                        account_clicked = True
                        break
                except:
                    continue
                    
                if i < len(click_strategies) - 1:  # Don't handle popups on last attempt
                    self.fast_handle_popups()
                    time.sleep(1)

            time.sleep(2)  # Reduced from 2

            # Fast navigation to payment methods
            payment_menus = [
                ("Payments & subscriptions", "Pembayaran & langganan"),
                ("Payment methods", "Metode pembayaran")
            ]
            
            for en_text, id_text in payment_menus:
                if not (self.device(text=en_text).click_exists(timeout=2) or 
                       self.device(text=id_text).click_exists(timeout=2)):
                    self.log_warn(f"Could not find {en_text}")
                time.sleep(2)  # Reduced from 2-3

            # Check if DOKU already exists
            if self.device(textStartsWith="paysafecard:").exists(timeout=3):
                self.log_info(f"✅ DOKU already exists on account {email}")
                
                # Save successful account (DOKU sudah ada)
                self.save_successful_account_safe(email, password)
                
                # Remove account after finding existing DOKU
                if self.fast_remove_google_account(email):
                    self.log_info(f"====== PROCESS COMPLETED SUCCESSFULLY (EXISTING DOKU) ======")
                    return True
                else:
                    self.log_error(f"Failed to remove account {email} after finding existing DOKU")
                    return False
            
            # Fast DOKU addition
            if not self.device(text="Add PaysafeCard").click_exists(timeout=8):
                self.log_error("Add PaysafeCard button not found")
                self.fast_remove_google_account(email)
                return False
                
            self.log_info("Add PaysafeCard button found and clicked")
            time.sleep(1)  # Reduced from 2

            self.fast_click_text(["Continue", "CONTINUE", "Lanjutkan", "LANJUTKAN"])
            time.sleep(1)  # Reduced from 2
            
            # Input Paysafecard account used for connecting in Play Store.
            self.device(className="android.widget.EditText", instance=0).set_text(psc_email)
            self.device(className="android.widget.EditText", instance=1).set_text(psc_pass)
            time.sleep(5)
            if self.device(text="Connect").exists(timeout=2):
                self.log_info("Connect button detected")
            time.sleep(2)
            self.click_connect_button()
            self.handle_connect_error_and_retry(max_retry=3)
            time.sleep(2)
            time.sleep(2)

            # Wait for DOKU e-Wallet process
            if self.device(text="PaysafeCard").exists(timeout=3):
                self.device(text="PaysafeCard").wait_gone(timeout=3)

            # Fast complete sign up
            if self.device(text="Complete sign up").exists(timeout=5):
                self.device(text="Full name").click()
                time.sleep(0.5)
                self.device(text="Full name").set_text("indonesian")
                self.fast_click_text(["Save", "SAVE", "Simpan", "SIMPAN"])
                time.sleep(3)  # Reduced from 3

            time.sleep(3)  # Reduced from 5

            # Quick success verification - PENTING: Hanya save jika benar-benar berhasil
            if self.device(textStartsWith="PaysafeCard:").exists(timeout=8):
                self.log_info(f"✅ PaysafeCard successfully added to account {email}")
                
                # HANYA save ke file hasil jika DOKU benar-benar berhasil ditambahkan
                self.save_successful_account_safe(email, password)
                
                # Fast account removal after success
                if self.fast_remove_google_account(email):
                    self.log_info(f"====== PROCESS COMPLETED SUCCESSFULLY ======")
                    return True
                else:
                    self.log_error(f"Failed to remove account {email} after DOKU addition")
                    return False
            else:
                self.log_warn(f"❌ Failed to detect DOKU on account {email} - NOT SAVING TO RESULTS")
                self.fast_remove_google_account(email)
                return False

        except Exception as e:
            self.log_error(f"Error processing account {email}: {e}")
            self.fast_remove_google_account(email)
            return False

    def save_successful_account_safe(self, email, password):
        """Thread-safe method to save successful account with duplicate prevention"""
        with self.result_file_lock:
            try:
                # Check if email already exists in results file
                existing_emails = set()
                if os.path.exists(RESULT_FILE):
                    with open(RESULT_FILE, "r") as f:
                        for line in f:
                            if "|" in line:
                                existing_email = line.split("|")[0].strip()
                                existing_emails.add(existing_email)
                
                # Only save if email doesn't already exist
                if email not in existing_emails:
                    with open(RESULT_FILE, "a") as hasil:
                        hasil.write(f"{email}|{password}\n")
                    self.log_info(f"✅ Successfully saved account {email} to results file")
                else:
                    self.log_warn(f"⚠️ Account {email} already exists in results file, skipping save")
                    
            except Exception as e:
                self.log_error(f"Error saving successful account {email}: {e}")

    def click_connect_button(self):
        # 1. Cari tombol dengan text "Connect" (case-insensitive)
        if self.device(textMatches="(?i)connect").exists(timeout=1):
            self.device(textMatches="(?i)connect").click()
            self.log_info("Clicked Connect by text")
            return True

        # 2. Cari semua button di layar
        buttons = self.device(className="android.widget.Button")
        if hasattr(buttons, 'count') and buttons.count > 0:
            # Jika hanya satu button, klik saja
            if buttons.count == 1:
                buttons.click()
                self.log_info("Clicked the only button on screen")
                return True
            # Jika lebih dari satu, klik yang paling besar (lebar x tinggi)
            max_area = 0
            max_btn = None
            for i in range(buttons.count):
                btn = self.device(className="android.widget.Button", instance=i)
                info = btn.info
                if info and "bounds" in info:
                    b = info["bounds"]
                    area = (b["right"]-b["left"]) * (b["bottom"]-b["top"])
                    if area > max_area:
                        max_area = area
                        max_btn = btn
            if max_btn:
                max_btn.click()
                self.log_info("Clicked the largest button on screen")
                return True

        # 3. Fallback: klik koordinat tengah layar (atau posisi tombol Connect)
        w, h = self.device.window_size()
        self.device.click(w//2, int(h*0.7))  # 70% dari atas, biasanya tombol bawah
        self.log_info("Clicked fallback coordinate for Connect")
        return False

    def handle_connect_error_and_retry(self, max_retry=3):
        retry = 0
        while retry < max_retry:
            time.sleep(2)
            # Deteksi popup error
            if self.device(text="We ran into a problem").exists(timeout=2):
                self.log_warn("Detected error popup after Connect, will close and retry...")
                # Klik tombol X (close)
                if self.device(description="Close").exists(timeout=1):
                    self.device(description="Close").click()
                elif self.device(text="×").exists(timeout=1):
                    self.device(text="×").click()
                else:
                    # Klik koordinat pojok kiri atas (X)
                    self.device.click(40, 60)
                time.sleep(1)
                # Coba klik Connect lagi
                self.click_connect_button()
                retry += 1
            else:
                break
        if retry == max_retry:
            self.log_error("Connect failed after several retries due to repeated error popup.")

def load_emulator_ports():
    """Load emulator ports from .env file"""
    load_dotenv()  # Load .env file
    
    emulator_ports = []
    port_counter = 1
    
    while True:
        port_key = f"port{port_counter}"
        port_value = os.getenv(port_key)
        
        if port_value is None:
            break
            
        try:
            port = int(port_value)
            emulator_ports.append(port)
            print(f"Loaded {port_key}: {port}")
            port_counter += 1
        except ValueError:
            print(f"Invalid port value for {port_key}: {port_value}")
            break
    
    return emulator_ports

def load_accounts():
    with open(INPUT_FILE, "r") as akun_file:
        return [line.strip() for line in akun_file if line.strip()]

def load_used_doku_numbers():
    """Load already used DOKU numbers from file"""
    used_numbers = set()
    try:
        if os.path.exists("emu/used_doku_numbers.txt"):
            with open("emu/used_doku_numbers.txt", "r") as f:
                used_numbers = set(line.strip() for line in f if line.strip())
    except Exception as e:
        print(f"Error loading used DOKU numbers: {e}")
    return used_numbers

def split_list(lst, num_parts=2):
    """Split list into equal parts"""
    chunk_size = len(lst) // num_parts
    remainder = len(lst) % num_parts
    
    parts = []
    start = 0
    
    for i in range(num_parts):
        # Add one extra item to first 'remainder' chunks
        end = start + chunk_size + (1 if i < remainder else 0)
        parts.append(lst[start:end])
        start = end
    
    return parts

def remove_processed_account(email):
    try:
        with open(INPUT_FILE, "r") as f:
            accounts = f.readlines()
        
        with open(INPUT_FILE, "w") as f:
            for account in accounts:
                if not account.startswith(f"{email}|"):
                    f.write(account)
    except Exception as e:
        print(f"Error removing processed account: {e}")

def fast_process_emulator(automator):
    """Optimized emulator processing with better error handling"""
    if automator.device is None and not automator.connect():
        return

    processed_count = 0
    success_count = 0

    while True:
        try:
            email_data = automator.email_queue.get_nowait()
            if email_data is None:
                break
            email, password = email_data.split("|")
            processed_count += 1
            # Use configured PaysafeCard credential.
            success = automator.fast_process_account(email, password, PSC_EMAIL, PSC_PASS)
            if success:
                success_count += 1
                remove_processed_account(email)
                automator.log_info(f"SUCCESS: {success_count}/{processed_count} accounts processed successfully")
            else:
                automator.log_info(f"FAILED: {success_count}/{processed_count} accounts processed successfully")
        except Empty:
            break
        except Exception as e:
            automator.log_error(f"Error in processing: {e}")
            continue
    automator.log_info(f"FINAL STATS: {success_count}/{processed_count} accounts processed successfully")

def main():
    """Main function with optimized multi-threading and .env support"""
    # Load emulator ports from .env file
    emulator_ports = load_emulator_ports()
    
    if not emulator_ports:
        print("No emulator ports found in .env file!")
        print("Please create a .env file with port configurations:")
        print("port1=16512")
        print("port2=16448")
        print("port3=16416")
        print("port4=16480")
        return
    
    # Create emulator instances dynamically based on .env and keep only online devices.
    emulators = []
    for i, port in enumerate(emulator_ports, 1):
        emulator = EmulatorAutomator(port, f"EMU{i}")
        emulators.append(emulator)
    
    print(f"Created {len(emulators)} emulator instances:")
    for emu in emulators:
        print(f"  - {emu.name}: Port {emu.port}")

    online_emulators = []
    print("Checking online emulators before splitting accounts...")
    for emu in emulators:
        if emu.connect():
            online_emulators.append(emu)
        else:
            print(f"{emu.name}: Port {emu.port} offline, skipping")

    if not online_emulators:
        print("No online emulators available!")
        return

    if len(online_emulators) < len(emulators):
        print(f"Using {len(online_emulators)}/{len(emulators)} online emulators")
    
    # Load and split data
    accounts = load_accounts()
    
    if not accounts:
        print(f"No accounts found in {INPUT_FILE}!")
        return
        
    print(f"Loaded {len(accounts)} accounts")
    
    # Split data among emulators
    num_emulators = len(online_emulators)
    account_parts = split_list(accounts, num_emulators)
    
    # Fill queues for each emulator
    for i, emu in enumerate(online_emulators):
        for acc in account_parts[i]:
            emu.email_queue.put(acc)
        print(f"{emu.name}: {len(account_parts[i])} accounts")
    
    # Use ThreadPoolExecutor for better thread management
    print("Starting optimized multi-emulator processing...")
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=num_emulators) as executor:
        # Submit all emulator tasks
        future_to_emulator = {
            executor.submit(fast_process_emulator, emu): emu 
            for emu in online_emulators
        }
        
        # Wait for completion and handle any exceptions
        for future in as_completed(future_to_emulator):
            emu = future_to_emulator[future]
            try:
                future.result()
                print(f"{emu.name} completed successfully")
            except Exception as e:
                print(f"{emu.name} generated an exception: {e}")
    
    end_time = time.time()
    total_time = end_time - start_time
    print(f"\nAll emulators completed in {total_time:.2f} seconds")
    print(f"Average time per emulator: {total_time/num_emulators:.2f} seconds")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run PaysafeCard linker worker.")
    parser.add_argument("--input-file", default=os.getenv("PSC_INPUT_FILE", "gsuite.txt"))
    parser.add_argument("--result-file", default=os.getenv("PSC_RESULT_FILE", "Hasil-Gdoku.txt"))
    parser.add_argument("--psc-email", default=os.getenv("PSC_EMAIL", ""))
    parser.add_argument("--psc-pass", default=os.getenv("PSC_PASS", ""))
    args = parser.parse_args()

    INPUT_FILE = args.input_file
    RESULT_FILE = args.result_file
    os.makedirs(os.path.dirname(RESULT_FILE) or ".", exist_ok=True)

    PSC_EMAIL = args.psc_email
    PSC_PASS = args.psc_pass
    if not PSC_EMAIL or not PSC_PASS:
        print("PSC_EMAIL and PSC_PASS are required. Set them in .env or pass --psc-email/--psc-pass.")
        raise SystemExit(1)
    main()
