import uiautomator2 as u2
import time
from datetime import datetime
import threading
from queue import Queue
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

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
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] INFO: {message}")

    def log_warn(self, message):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] WARNING: {message}")

    def log_error(self, message):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{self.name}] ERROR: {message}")

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

    def fast_process_account(self, email, password, nomor_doku):
        try:
            self.log_info(f"====== STARTING NEW ACCOUNT PROCESS ======")
            self.log_info(f"Email: {email}, DOKU: {nomor_doku}")
            
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
            self.device(text="Add DOKU").exists(timeout=8)  # Reduced from 10
            
            # Fast password input
            self.device(className="android.widget.EditText").set_text('masuk123')
            time.sleep(1)  # Reduced from 3
            
            self.fast_click_text(["NEXT", "Next", "Berikutnya", "BERIKUTNYA"])
            time.sleep(2)  # Reduced from 3

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
            time.sleep(3)  # Reduced from 5

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

            time.sleep(1)  # Reduced from 2

            # Fast navigation to payment methods
            payment_menus = [
                ("Payments & subscriptions", "Pembayaran & langganan"),
                ("Payment methods", "Metode pembayaran")
            ]
            
            for en_text, id_text in payment_menus:
                if not (self.device(text=en_text).click_exists(timeout=2) or 
                       self.device(text=id_text).click_exists(timeout=2)):
                    self.log_warn(f"Could not find {en_text}")
                time.sleep(1)  # Reduced from 2-3

            # Check if DOKU already exists
            if self.device(textStartsWith="DOKU:").exists(timeout=3):
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
            if not self.device(text="Add DOKU").click_exists(timeout=8):
                self.log_error("Add DOKU button not found")
                self.fast_remove_google_account(email)
                return False
                
            self.log_info("Add DOKU button found and clicked")
            time.sleep(1)  # Reduced from 2

            self.fast_click_text(["Continue", "CONTINUE", "Lanjutkan", "LANJUTKAN"])
            time.sleep(1)  # Reduced from 2
            
            # Fast DOKU number input
            self.device(className="android.widget.EditText").set_text(nomor_doku)
            self.fast_click_text(["MASUK", "Masuk", "LOGIN", "Login"])
            time.sleep(2)  # Reduced from 3

            # Fast OTP input with parallel processing
            otp_digits = ["1", "2", "3", "1", "2", "3"]
            for i, digit in enumerate(otp_digits):
                self.device(className="android.widget.EditText", instance=i).set_text(digit)
                time.sleep(0.2)  # Reduced from 0.4

            # Wait for DOKU e-Wallet process
            if self.device(text="DOKU e-Wallet").exists(timeout=8):
                self.device(text="DOKU e-Wallet").wait_gone(timeout=8)

            # Fast complete sign up
            if self.device(text="Complete sign up").exists(timeout=12):
                self.device(text="Full name").click()
                time.sleep(0.5)
                self.device(text="Full name").set_text("indonesian")
                self.fast_click_text(["Save", "SAVE", "Simpan", "SIMPAN"])
                time.sleep(2)  # Reduced from 3

            time.sleep(3)  # Reduced from 5

            # Quick success verification - PENTING: Hanya save jika benar-benar berhasil
            if self.device(textStartsWith="DOKU:").exists(timeout=8):
                self.log_info(f"✅ DOKU successfully added to account {email}")
                
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
                if os.path.exists("Hasil-Gdoku.txt"):
                    with open("Hasil-Gdoku.txt", "r") as f:
                        for line in f:
                            if "|" in line:
                                existing_email = line.split("|")[0].strip()
                                existing_emails.add(existing_email)
                
                # Only save if email doesn't already exist
                if email not in existing_emails:
                    with open("Hasil-Gdoku.txt", "a") as hasil:
                        hasil.write(f"{email}|{password}\n")
                    self.log_info(f"✅ Successfully saved account {email} to results file")
                else:
                    self.log_warn(f"⚠️ Account {email} already exists in results file, skipping save")
                    
            except Exception as e:
                self.log_error(f"Error saving successful account {email}: {e}")

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
    with open("gsuite.txt", "r") as akun_file:
        return [line.strip() for line in akun_file if line.strip()]

def load_used_doku_numbers():
    """Load already used DOKU numbers from file"""
    used_numbers = set()
    try:
        if os.path.exists("used_doku_numbers.txt"):
            with open("used_doku_numbers.txt", "r") as f:
                used_numbers = set(line.strip() for line in f if line.strip())
    except Exception as e:
        print(f"Error loading used DOKU numbers: {e}")
    return used_numbers

def save_used_doku_number(nomor_doku):
    """Save a DOKU number as used"""
    try:
        with open("used_doku_numbers.txt", "a") as f:
            f.write(f"{nomor_doku}\n")
    except Exception as e:
        print(f"Error saving used DOKU number: {e}")

def load_doku_numbers():
    """Load available DOKU numbers and filter out used ones"""
    used_numbers = load_used_doku_numbers()
    available_numbers = []
    
    try:
        with open("Result-Doku-Unused.txt", "r") as doku_file:
            doku_lines = [line.strip() for line in doku_file if line.strip()]
            
        for line in doku_lines:
            number = line.split("|")[0]
            if number not in used_numbers:
                available_numbers.append(number)
    except Exception as e:
        print(f"Error loading DOKU numbers: {e}")
        
    return available_numbers

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
        with open("gsuite.txt", "r") as f:
            accounts = f.readlines()
        
        with open("gsuite.txt", "w") as f:
            for account in accounts:
                if not account.startswith(f"{email}|"):
                    f.write(account)
    except Exception as e:
        print(f"Error removing processed account: {e}")

def remove_used_doku(nomor_doku):
    try:
        with open("Result-Doku-Unused.txt", "r") as f:
            doku_lines = f.readlines()
        
        with open("Result-Doku-Unused.txt", "w") as f:
            for line in doku_lines:
                if not line.startswith(f"{nomor_doku}|"):
                    f.write(line)
    except Exception as e:
        print(f"Error removing used DOKU: {e}")

def fast_process_emulator(automator):
    """Optimized emulator processing with better error handling"""
    if not automator.connect():
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
            
            # Get next available DOKU number with thread safety
            with automator.used_doku_lock:
                try:
                    nomor_doku = automator.doku_queue.get_nowait()
                    
                    # Double check if number is already used
                    used_numbers = load_used_doku_numbers()
                    if nomor_doku in used_numbers:
                        automator.log_warn(f"DOKU number {nomor_doku} already used, skipping...")
                        continue
                        
                    # Mark number as used before processing
                    save_used_doku_number(nomor_doku)
                    
                except Queue.Empty:
                    automator.log_error("No DOKU numbers available")
                    break
            
            # Use the fast processing method
            success = automator.fast_process_account(email, password, nomor_doku)
            
            if success:
                success_count += 1
                remove_processed_account(email)
                remove_used_doku(nomor_doku)
                automator.log_info(f"SUCCESS: {success_count}/{processed_count} accounts processed successfully")
            else:
                # Remove the number from used list if process failed
                try:
                    with open("used_doku_numbers.txt", "r") as f:
                        lines = f.readlines()
                    with open("used_doku_numbers.txt", "w") as f:
                        for line in lines:
                            if line.strip() != nomor_doku:
                                f.write(line)
                except Exception as e:
                    automator.log_error(f"Error removing failed DOKU number: {e}")
                
                automator.log_info(f"FAILED: {success_count}/{processed_count} accounts processed successfully")
                
        except Queue.Empty:
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
    
    # Create emulator instances dynamically based on .env
    emulators = []
    for i, port in enumerate(emulator_ports, 1):
        emulator = EmulatorAutomator(port, f"EMU{i}")
        emulators.append(emulator)
    
    print(f"Created {len(emulators)} emulator instances:")
    for emu in emulators:
        print(f"  - {emu.name}: Port {emu.port}")
    
    # Load and split data
    accounts = load_accounts()
    doku_numbers = load_doku_numbers()
    
    if not doku_numbers:
        print("No available DOKU numbers found or all numbers are used!")
        return
    
    if not accounts:
        print("No accounts found in gsuite.txt!")
        return
        
    print(f"Loaded {len(accounts)} accounts and {len(doku_numbers)} DOKU numbers")
    
    # Split data among emulators
    num_emulators = len(emulators)
    account_parts = split_list(accounts, num_emulators)
    doku_parts = split_list(doku_numbers, num_emulators)
    
    # Fill queues for each emulator
    for i, emu in enumerate(emulators):
        for acc in account_parts[i]:
            emu.email_queue.put(acc)
        for doku in doku_parts[i]:
            emu.doku_queue.put(doku)
        print(f"{emu.name}: {len(account_parts[i])} accounts, {len(doku_parts[i])} DOKU numbers")
    
    # Use ThreadPoolExecutor for better thread management
    print("Starting optimized multi-emulator processing...")
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=num_emulators) as executor:
        # Submit all emulator tasks
        future_to_emulator = {
            executor.submit(fast_process_emulator, emu): emu 
            for emu in emulators
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
    main()