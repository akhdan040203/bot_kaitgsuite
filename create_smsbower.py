import os
import hashlib
import aiohttp
import asyncio
from aiohttp import ClientSession
from aiohttp.client_exceptions import ClientError
import random
import time
from datetime import datetime, timezone
from colorama import Fore, Style
from faker import Faker
from dotenv import load_dotenv
from tabulate import tabulate

# Initialize Faker and load environment variables
faker_instance = Faker()
load_dotenv()

# API credentials
API_KEY = os.getenv("SMSBOWER_API_KEY")
PROXY_URL = os.getenv("PROXY_URL")
BASE_URL = "https://smsbower.online/stubs/handler_api.php"  # Changed to SMSVirtual URL
DOKU_API = "https://my.dokuwallet.com/DWMobileAPI"

# Colorama formatting
info = Fore.YELLOW + '[info] ' + Style.RESET_ALL
success = Fore.GREEN + '[success] ' + Style.RESET_ALL
failed = Fore.RED + '[failed] ' + Style.RESET_ALL
submit = Fore.MAGENTA + '[submit] ' + Style.RESET_ALL

# File paths
RESULT_FILE = "dokufresh.txt"

# Version and salt for API requests
version = '3.0'
salt = 'MoB!l3D0KV'

# Load proxy from environment variable
def load_proxy_from_env():
    if not PROXY_URL:
        print(failed + "No PROXY_URL found in .env.")
        return None
    return PROXY_URL

def ask_proxy_usage():
    while True:
        use_proxy = input(Fore.GREEN + '[?] Use proxy? (y/n): ' + Style.RESET_ALL).lower()
        if use_proxy in ['y', 'n']:
            if use_proxy == 'y':
                proxy = load_proxy_from_env()
                if proxy:
                    print(info + f"Using proxy: {proxy}")
                    return {"http": proxy, "https": proxy}
                else:
                    print(failed + "No proxy available. Proceeding without proxy.")
                    return {}
            else:
                print(info + "Proceeding without proxy.")
                return {}
        else:
            print(failed + "Please enter 'y' or 'n'")

# Validate proxy
async def validate_proxy(proxy_url, session: ClientSession):
    if not proxy_url:
        return False
    test_url = "https://ifconfig.me/ip"
    try:
        async with session.get(test_url, proxy=proxy_url, timeout=10) as response:
            if response.status == 200:
                ip = await response.text()
                print(success + f"Proxy valid - IP: {ip.strip()}")
                return True
            else:
                print(failed + f"Proxy invalid: Status code {response.status}")
                return False
    except ClientError as e:
        print(failed + f"Proxy invalid: {str(e)}")
        return False

# Check SMSVirtual balance
async def checkbalance(session: ClientSession):
    headers = {"X-Api-Key": API_KEY}
    try:
        async with session.get(f"{BASE_URL}/profile/", headers=headers, timeout=10) as response:
            response.raise_for_status()
            result = await response.json()
            if result.get("data"):
                balance = result["data"]["balance"]
                logo(
                    full_name="SMSVirtual",
                    balance=balance,
                    usd_balance=balance
                )
            else:
                print(failed + f"Failed to get balance: {result}")
    except ClientError as e:
        print(failed + f"Error contacting API: {str(e)}")

# Display balance in a table
def logo(full_name, balance, usd_balance):
    data = [
        ["Users", full_name],
        ["SMSVirtual", f"{usd_balance} RUBEL"],
    ]
    print(tabulate(data, headers=["•", "•"], tablefmt="fancy_grid"))

# Generate username for email
def create_username():
    first = faker_instance.first_name().lower()
    last = faker_instance.last_name().lower()
    return f"{first}{last}"

# Get temporary email from generator.email
async def get_email(username, domain, session: ClientSession):
    url = f"https://generator.email/{username}@{domain}"
    headers = {
        "sec-ch-ua": '"Not)A;Brand";v="99", "Android WebView";v="127", "Chromium";v="127"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0 (Linux; Android 14; RMX3933 Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.64 Mobile Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "dnt": "1",
        "x-requested-with": "mark.via.gp",
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-user": "?1",
        "sec-fetch-dest": "document",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "priority": "u=0, i",
    }
    try:
        async with session.get(url, headers=headers, proxy=proxy_url, timeout=10, allow_redirects=False) as response:
            if response.status == 302:
                email = f"{username}@{domain}"
                print(success + f"Email created: {email}")
                return email
            elif response.status == 200:
                print(failed + f"Email not created: Status 200 but no redirect for {username}@{domain}.")
                return None
            else:
                print(failed + f"Unexpected status: {response.status} for {username}@{domain}")
                return None
    except ClientError as e:
        print(failed + f"Failed to get email: {str(e)}")
        return None

# Get phone number from SMSVirtual
async def get_number(session: ClientSession):
    params = {
        "api_key": API_KEY,
        "action": "getNumber",
        "service": "akl",
        "country": "6",
        "maxPrice": "1",
        "ref": "ref$ref"
    }

    try:
        async with session.get(BASE_URL, params=params, proxy=proxy_url, timeout=10) as response:
            text = await response.text()
            if "ACCESS_NUMBER" in text:
                _, activation_id, phone_number = text.strip().split(":")
                print(success + f"Number acquired: {phone_number}, Activation ID: {activation_id}")
                return activation_id, phone_number
            else:
                print(failed + f"Failed to get number: {text}")
                return None, None
    except ClientError as e:
        print(failed + f"Error retrieving number: {str(e)}")
        await asyncio.sleep(1)
        return None, None
    except Exception as e:
        print(failed + f"Exception while getting number: {str(e)}")
        return None, None

# Set status functions for SMSVirtual
async def set_status_ready(activation_id, session: ClientSession):
    # SMSVirtual doesn't need a ready status
    return True

async def set_status_resend(activation_id, session: ClientSession):
    headers = {"X-Api-Key": API_KEY}
    try:
        async with session.patch(f"{BASE_URL}/order/{activation_id}/2", headers=headers, proxy=proxy_url, timeout=10) as response:
            if response.status == 200:
                print(success + f"Requested SMS resend for activation {activation_id}")
                return True
            print(failed + f"Failed to request SMS resend: {await response.text()}")
            return False
    except ClientError as e:
        print(failed + f"Error requesting SMS resend: {str(e)}")
        return False

async def set_status_cancel(activation_id, session: ClientSession):
    params = {
        "api_key": API_KEY,
        "action": "setStatus",
        "status": "8",
        "id": activation_id
    }
    try:
        async with session.get(BASE_URL, params=params, proxy=proxy_url, timeout=10) as response:
            text = await response.text()
            print(info + f"Cancel result: {text}")
            return "ACCESS_CANCEL" in text
    except Exception as e:
        print(failed + f"Cancel error: {str(e)}")
        return False
    except ClientError as e:
        print(failed + f"Error canceling activation {activation_id}: {str(e)}")
        return False

# Retrieve OTP from SMSVirtual
async def get_otpdoku(activation_id, session: ClientSession, otp_lama=None, max_attempts=15):
    print(info + "Waiting for OTP from SMSBower...")
    start_time = time.time()
    total_timeout = 120  # 2 minutes timeout
    poll_interval = 8
    
    for attempt in range(max_attempts):
        try:
            params = {
                "api_key": API_KEY,
                "action": "getStatus",
                "id": activation_id
            }
            async with session.get(BASE_URL, params=params, proxy=proxy_url, timeout=10) as response:
                text = await response.text()
                print(info + f"Polling result: {text}")

                if "STATUS_OK" in text:
                    code = text.split(":")[1].strip()
                    print(success + f"OTP Received: {code}")
                    return code
                elif "STATUS_WAIT_CODE" in text or "STATUS_WAIT_RETRY" in text:
                    print(info + "Waiting for SMS...")
                elif "STATUS_CANCEL" in text:
                    print(failed + "Activation canceled.")
                    return None
                else:
                    print(info + f"Unknown status: {text}")
        except Exception as e:
            print(failed + f"Error while polling OTP: {str(e)}")

        time_elapsed = time.time() - start_time
        if time_elapsed >= total_timeout:
            print(failed + f"Timeout: No OTP received within {total_timeout} seconds.")
            break

        remaining_time = total_timeout - time_elapsed
        if remaining_time > 0:
            wait_time = min(poll_interval, remaining_time)
            print(info + f"Attempt {attempt + 1}/{max_attempts}, retrying in {wait_time:.1f} seconds... (Timeout in {remaining_time:.1f}s)")
            await asyncio.sleep(wait_time)

    print(info + "Canceling order after timeout...")
    await set_status_cancel(activation_id, session)
    return None

# Generate hash for API requests
def getWords(string):
    return hashlib.sha1(string.encode()).hexdigest()

# Send OTP to phone number
async def send_otp(no_hp, session: ClientSession):
    try:
        words = getWords(f'{version}{no_hp}{salt}')
        payload = {
            "phoneNo": no_hp,
            "version": version,
            "app_version": "3.1.4",
            "deviceId": "1",
            "words": words
        }
        async with session.post(
            f'{DOKU_API}/apprequest/doSendOtpForRegistration',
            data=payload,
            proxy=proxy_url,
            timeout=10
        ) as res:
            response_data = await res.json()
            response_code = response_data['responseCode']
            if response_code == '0000':
                print(info + f"OTP sent to {no_hp}")
                return True
            else:
                print(failed + f"Failed to send OTP: {response_data['responseMsg']}")
                return False
    except Exception as e:
        print(failed + f"Send OTP error: {str(e)}")
        return False

# Validate OTP
async def validate_otp(no_hp, otp, session: ClientSession):
    try:
        words = getWords(f'{version}{otp}{no_hp}{salt}')
        payload = {
            "phoneNo": no_hp,
            "OTP": otp,
            "version": "3.0",
            "app_version": "3.1.4",
            "deviceId": "1",
            "words": words
        }
        async with session.post(
            f'{DOKU_API}/apprequest/doValidateOtpForRegistration',
            data=payload,
            proxy=proxy_url,
            timeout=10
        ) as res:
            response_data = await res.json()
            response_code = response_data['responseCode']
            if response_code == '0000':
                print(info + f"OTP validated for {no_hp}")
                return True
            else:
                print(failed + f"Failed to validate OTP: {response_data['responseMsg']}")
                return False
    except Exception as e:
        print(failed + f"Validate OTP error: {str(e)}")
        return False

# Submit DOKU registration form
async def submit_form(no_hp, email_doku, name, otp, session: ClientSession):
    try:
        if not all([no_hp, email_doku, name, otp]):
            print(failed + f"Missing required fields: phone={no_hp}, email={email_doku}, name={name}, otp={otp}")
            return False
        words = getWords(f'{no_hp}{salt}{email_doku}{otp}')
        params = {
            "REQUESTTYPE": "doSignUp",
            "PHONE": no_hp,
            "WORDS": words,
            "VERSION": "2.1",
            "PIN": "OWLv2nadLlHOQq9OLwbWuAHQQ0FUOFeJmqw9b20ZBRnzQosUw4TanYffGKg8vrkeO8SA9Jpbx+Yb/9yCJNKZQm3iqiUCPBiTH5StbgjpIprzsTMQCuFZ5SfMnD73Fo8XeD7JZnw2ycEEXpEAqmjbLtIF6t/WJuvZtXKIDIAtLWtJjzRHCkt/j3Yk5XHhdw2/oGq33Urwah/t+F3PdXEkmBj5GWRVLlDEf4jkMXCI7BJWNSVsuKf8y/y2Bk59wRfnaXx6SgEmltxTiaDrw7tXXcyLHngZKcYUWF6PRrr4f2Gbw4gX8Zo3kaHXNn4PQ1Ltze70Nvpi9KcToz52upQSEg==",
            "APP_VERSION": "3.1.3",
            "DEVICEID": "2",
            "NAME": name,
            "EMAIL": email_doku,
            "GENDER": random.choice(['F', 'M']),
            "OTP": otp,
            "REQUEST_TIMESTAMP": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        }
        print(info + f"Submitting form for phone {no_hp}")
        async with session.post(
            f'{DOKU_API}/apprequest',
            params=params,
            proxy=proxy_url,
            timeout=10
        ) as res:
            text = await res.text()
            if 'dynamicMenuFavorites' in text:
                print(success + f"Form submitted successfully for phone {no_hp}")
                return True
            else:
                print(failed + f"Form submission failed: API response - {text}")
                return False
    except Exception as e:
        print(failed + f"Form submission error: {str(e)}")
        return False

# Main DOKU registration function
async def register_doku_account(account_number, domain, session: ClientSession, semaphore: asyncio.Semaphore, attempt=1, max_account_attempts=3):
    async with semaphore:
        print(info + f"Starting DOKU registration for account {account_number} (Attempt {attempt}/{max_account_attempts})")
        # Generate and get temporary email
        max_email_attempts = 3
        email_doku = None
        for attempt in range(max_email_attempts):
            username = create_username()
            print(info + f"Attempting to create email: {username}@{domain} (Attempt {attempt + 1}/{max_email_attempts})")
            email_doku = await get_email(username, domain, session)
            if email_doku:
                break
            print(failed + f"Failed to create email. Retrying...")
            await asyncio.sleep(2)
        if not email_doku:
            print(failed + f"Failed to create temporary email after maximum attempts.")
            return False

        print(info + f"Using email: {email_doku}")
        no_hp = None
        activation_id = None
        max_number_attempts = 3
        
        # Get phone number
        for attempt in range(max_number_attempts):
            print(info + f"Getting number (attempt {attempt + 1}/{max_number_attempts})")
            try:
                activation_id, no_hp = await get_number(session)
                if no_hp and activation_id:
                    print(info + f"Phone number: {no_hp}")
                    break
                print(failed + f"Failed to get valid number. Retrying...")
                await asyncio.sleep(2)
            except Exception as e:
                print(failed + f"Error getting number: {str(e)}. Retrying...")
                await asyncio.sleep(2)
                if attempt == max_number_attempts - 1:
                    print(failed + "Max attempts reached for getting number.")
                    return False
        
        # Set activation status to ready
        if not await set_status_ready(activation_id, session):
            print(info + f"Failed to set activation {activation_id} to ready, proceeding anyway")
        
        # Send and validate OTP
        max_otp_attempts = 2
        otp = None
        for otp_attempt in range(max_otp_attempts):
            if not await send_otp(no_hp, session):
                print(failed + f"Failed to send OTP for {no_hp}")
                await set_status_cancel(activation_id, session)
                return False
            
            print(info + 'Retrieving OTP...')
            otp = await get_otpdoku(activation_id, session)
            if not otp and otp_attempt < max_otp_attempts - 1:
                print(info + f"Requesting OTP resend for {no_hp}")
                await set_status_resend(activation_id, session)
                await asyncio.sleep(5)
                continue
            if not otp:
                print(failed + f"Failed to get OTP after {max_otp_attempts} attempts")
                await set_status_cancel(activation_id, session)
                return False
            
            print(info + f"OTP: {otp} for {no_hp}")
            if not await validate_otp(no_hp, otp, session):
                print(failed + f"Failed to verify OTP for {no_hp}")
                await set_status_cancel(activation_id, session)
                return False
            
            # Generate name and submit form
            try:
                name = f'{faker_instance.first_name()} {faker_instance.last_name()}'
                print(info + f"Generated name: {name}")
            except Exception as e:
                print(failed + f"Failed to generate name: {str(e)}")
                await set_status_cancel(activation_id, session)
                return False
            
            pin = '123123'
            print(submit + f'{no_hp} - {pin}')
            
            if not await submit_form(no_hp, email_doku, name, otp, session):
                print(failed + f"Failed to submit form for {no_hp}")
                await set_status_cancel(activation_id, session)
                return False
            
            # Save result
            with open(RESULT_FILE, 'a', encoding='utf-8') as f:
                f.write(f'{no_hp}|{pin}|{email_doku}\n')
            print(success + f'DOKU account {account_number} created: {no_hp} - {pin}')
            return True

async def main():
    async with aiohttp.ClientSession() as session:
        # Ask about proxy usage
        global proxy_url, proxies
        proxies = ask_proxy_usage()
        proxy_url = proxies.get("http", None)

        # Display SMSVirtual balance
        print(info + "Checking SMSVirtual balance...")
        await checkbalance(session)
        print("Developer: @forumkt on Telegram")
        print(info + "="*50)
        
        # Validate proxy if being used
        if proxy_url:
            await validate_proxy(proxy_url, session)
        
        # Get number of accounts to create
        while True:
            try:
                num_accounts = int(input(Fore.GREEN + '[?] Enter the number of DOKU accounts to create: ' + Style.RESET_ALL))
                if num_accounts > 0:
                    print(info + f"Will attempt to create {num_accounts} DOKU accounts.")
                    break
                else:
                    print(failed + "Please enter a positive number.")
            except ValueError:
                print(failed + "Invalid input. Please enter a number.")
        
        # Get email domain
        domain = input(Fore.GREEN + '[?] Enter email domain from generator.email: ' + Style.RESET_ALL).strip()
        print(info + f"Using email domain: {domain}")
        
        # Register DOKU accounts with retries
        semaphore = asyncio.Semaphore(3)  # Limit to 3 concurrent tasks
        successful_accounts = 0
        total_attempts = 0
        max_account_attempts = 3
        pending_accounts = list(range(1, num_accounts + 1))
        failed_accounts = []
        account_counter = num_accounts  # Untuk nomor akun baru saat retry

        while successful_accounts < num_accounts and pending_accounts:
            tasks = []
            for account_number in pending_accounts[:]:
                print(info + f"Scheduling account {account_number}/{num_accounts}")
                task = register_doku_account(account_number, domain, session, semaphore, attempt=1, max_account_attempts=max_account_attempts)
                tasks.append((account_number, task))
                total_attempts += 1
            
            # Run tasks
            results = await asyncio.gather(*[task for _, task in tasks], return_exceptions=True)
            new_pending_accounts = []
            for (account_number, _), result in zip(tasks, results):
                if result is True:
                    successful_accounts += 1
                    pending_accounts.remove(account_number)
                else:
                    # Try again with a new attempt
                    attempts_file = f"{account_number}.attempts"
                    try:
                        with open(attempts_file, 'r') as f:
                            current_attempts = int(f.read()) + 1
                    except FileNotFoundError:
                        current_attempts = 1
                    with open(attempts_file, 'w') as f:
                        f.write(str(current_attempts))
                    
                    if current_attempts < max_account_attempts:
                        print(failed + f"Account {account_number} failed, scheduling retry (Attempt {current_attempts + 1}/{max_account_attempts})")
                        new_pending_accounts.append(account_number)
                    else:
                        print(failed + f"Account {account_number} failed after {max_account_attempts} attempts, moving to next account")
                        pending_accounts.remove(account_number)
                        failed_accounts.append(account_number)
                        account_counter += 1
                        if successful_accounts + len(pending_accounts) < num_accounts:
                            new_pending_accounts.append(account_counter)
                            with open(f"{account_counter}.attempts", 'w') as f:
                                f.write("0")
            
            pending_accounts = new_pending_accounts
            print(info + "="*50)
            await asyncio.sleep(2)  # Brief pause between retry rounds
        
        # Clean up attempt files
        for account_number in range(1, account_counter + 1):
            try:
                os.remove(f"{account_number}.attempts")
            except FileNotFoundError:
                pass
        
        # Summary
        print(success + f"Completed: Successfully created {successful_accounts}/{num_accounts} DOKU accounts.")
        if failed_accounts:
            print(failed + f"Permanently failed accounts after {max_account_attempts} attempts: {len(failed_accounts)}")
        print(info + f"Total attempts made: {total_attempts}")
        print(info + f"Results saved to {RESULT_FILE}")

if __name__ == "__main__":
    asyncio.run(main())

async def set_status_ready(activation_id, session: ClientSession):
    params = {
        "api_key": API_KEY,
        "action": "setStatus",
        "status": "1",
        "id": activation_id
    }
    try:
        async with session.get(BASE_URL, params=params, proxy=proxy_url, timeout=10) as response:
            return "ACCESS_READY" in await response.text()
    except:
        return False


async def set_status_resend(activation_id, session: ClientSession):
    params = {
        "api_key": API_KEY,
        "action": "setStatus",
        "status": "3",
        "id": activation_id
    }
    try:
        async with session.get(BASE_URL, params=params, proxy=proxy_url, timeout=10) as response:
            return "ACCESS_RETRY_GET" in await response.text()
    except:
        return False
