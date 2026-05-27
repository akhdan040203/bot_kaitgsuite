from flask import Flask, jsonify, request
import imaplib
import smtplib
import email
from email.header import decode_header
from faker import Faker
import random

app = Flask(__name__)

# Konfigurasi kredensial email Hostinger untuk admin
IMAP_SERVER = 'imap.gmail.com'
SMTP_SERVER = 'smtp.gmail.com'
EMAIL_ACCOUNT = 'tatakaeoraaa@gmail.com'
PASSWORD = 'nhlc uydm dpao nwve'

# IMAP_SERVER = 'imap.hostinger.com'
# SMTP_SERVER = 'smtp.hostinger.com'
# EMAIL_ACCOUNT = 'admin@premigu.id'
# PASSWORD = 'Premigu#123'

fake = Faker()

def connect_imap():
    mail = imaplib.IMAP4_SSL(IMAP_SERVER)
    mail.login(EMAIL_ACCOUNT, PASSWORD)
    return mail

def connect_smtp():
    server = smtplib.SMTP(SMTP_SERVER, 587)
    server.starttls()
    server.login(EMAIL_ACCOUNT, PASSWORD)
    return server

@app.route('/emails', methods=['GET'])
def get_emails():
    target_email = request.args.get('target')  # Email target default ke bobcabrera

    mail = connect_imap()
    mail.select('inbox')
    
    # Cari email yang ditujukan ke target email
    result, data = mail.search(None, f'TO "{target_email}"')
    
    if result != 'OK':
        return jsonify({'error': 'Gagal mencari email.'}), 500

    email_ids = data[0].split()

    emails = []
    for eid in email_ids[-5:]:  # Ambil 5 email terbaru
        result, msg_data = mail.fetch(eid, '(RFC822)')
        raw_email = msg_data[0][1]
        msg = email.message_from_bytes(raw_email)

        # Mendapatkan subject
        subject, encoding = decode_header(msg['Subject'])[0]
        if isinstance(subject, bytes):
            subject = subject.decode(encoding if encoding else 'utf-8')
        
        from_ = msg.get('From')

        # Mengambil body dari email
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                content_disposition = str(part.get("Content-Disposition"))

                # Ambil bagian teks yang tidak memiliki attachment
                if content_type == "text/plain" and "attachment" not in content_disposition:
                    try:
                        body = part.get_payload(decode=True).decode()
                    except Exception as e:
                        body = f"Error decoding body: {str(e)}"
        else:
            # Jika bukan multipart, langsung ambil payload
            try:
                body = msg.get_payload(decode=True).decode()
            except Exception as e:
                body = f"Error decoding body: {str(e)}"

        emails.append({
            'id': eid.decode(),
            'from': from_,
            'subject': subject,
            'body': body  # Menambahkan body ke respons
        })

    mail.logout()
    return jsonify(emails)

@app.route('/send-email', methods=['POST'])
def send_email():
    data = request.json
    recipient = data.get('to')
    subject = data.get('subject')
    body = data.get('body')

    server = connect_smtp()
    msg = f"Subject: {subject}\n\n{body}"
    server.sendmail(EMAIL_ACCOUNT, recipient, msg)
    server.quit()
    
    return jsonify({'message': 'Email sent successfully!'})

@app.route('/generate-email', methods=['GET'])
def generate_email():
    """Generate an email with random details"""
    first_name = fake.first_name()
    last_name = fake.last_name()
    domains = ['premkuy.shop']  # Anda bisa mengubah domain sesuai kebutuhan
    domain = random.choice(domains)
    email_address = f"{first_name.lower()}{last_name.lower()}1@{domain}"
    
    return jsonify({
        'first_name': first_name,
        'last_name': last_name,
        'email': email_address
    })

if __name__ == '__main__':
    app.run(debug=True)
