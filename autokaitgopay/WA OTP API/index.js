const express = require('express');

const app = express();
const PORT = process.env.PORT || 3089;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// OTP Store - simpan OTP terbaru per phone
// ============================================
const otpStore = new Map();
const OTP_TTL = 5 * 60 * 1000; // 5 menit

function storeOTP(phone, otp) {
    otpStore.set(phone, {
        otp,
        timestamp: Date.now(),
    });
    console.log(`✅ OTP stored: ${otp} (phone: ${phone})`);

    // Auto-delete after TTL
    setTimeout(() => {
        const entry = otpStore.get(phone);
        if (entry && entry.otp === otp) {
            otpStore.delete(phone);
            console.log(`🗑️ OTP expired: ${otp} (phone: ${phone})`);
        }
    }, OTP_TTL);
}

// ============================================
// Webhook endpoint - terima notifikasi forward
// ============================================
app.post('/webhook', (req, res) => {
    const body = req.body;
    console.log('\n📩 Webhook received:');
    console.log(JSON.stringify(body, null, 2));

    // Cari text dari berbagai format payload
    const text = body.text || body.message || body.body || body.content
        || body.notification?.text || body.notification?.body
        || body.data?.text || body.data?.body || body.data?.message
        || (typeof body === 'string' ? body : JSON.stringify(body));

    console.log(`   Text: "${text}"`);

    // Extract 6-digit OTP
    const otpMatch = String(text).match(/(\d{6})/);
    if (otpMatch) {
        const otp = otpMatch[1];

        // Cari nomor phone dari payload atau gunakan default
        const phone = body.phone || body.from || body.sender
            || body.notification?.phone || body.data?.phone
            || 'default';

        storeOTP(phone, otp);
        console.log(`   ✅ OTP: ${otp} from phone: ${phone}`);

        res.json({ success: true, otp, phone });
    } else {
        console.log('   ⚠️ No OTP found in message');
        res.json({ success: false, message: 'No OTP found' });
    }
});

// Webhook GET (untuk test)
app.get('/webhook', (req, res) => {
    res.json({
        status: 'active',
        message: 'Webhook ready. POST notification data to this URL.',
        stored_otps: otpStore.size,
    });
});

// ============================================
// GET OTP - ambil OTP terbaru
// ============================================
app.get('/otp', (req, res) => {
    // Return latest OTP from any phone
    let latest = null;
    for (const [phone, entry] of otpStore) {
        if (!latest || entry.timestamp > latest.timestamp) {
            latest = { phone, ...entry };
        }
    }

    if (latest && Date.now() - latest.timestamp < OTP_TTL) {
        // Auto-delete after retrieval
        otpStore.delete(latest.phone);
        res.json({ success: true, otp: latest.otp, phone: latest.phone });
    } else {
        res.json({ success: false, message: 'No OTP available' });
    }
});

app.get('/otp/:phone', (req, res) => {
    const phone = req.params.phone;
    const entry = otpStore.get(phone);

    if (entry && Date.now() - entry.timestamp < OTP_TTL) {
        otpStore.delete(phone);
        res.json({ success: true, otp: entry.otp });
    } else {
        res.json({ success: false, message: 'No OTP for this phone' });
    }
});

// ============================================
// GET OTP with polling (wait for OTP)
// ============================================
app.get('/otp/wait/:timeout', async (req, res) => {
    const timeout = parseInt(req.params.timeout) || 120;
    const start = Date.now();

    while (Date.now() - start < timeout * 1000) {
        // Check for any OTP
        let latest = null;
        for (const [phone, entry] of otpStore) {
            if (!latest || entry.timestamp > latest.timestamp) {
                latest = { phone, ...entry };
            }
        }

        if (latest && latest.timestamp > start - 5000) {
            otpStore.delete(latest.phone);
            return res.json({ success: true, otp: latest.otp, phone: latest.phone });
        }

        await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ success: false, message: 'Timeout waiting for OTP' });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================
// Start server
// ============================================
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`🚀 OTP Webhook Server running on port ${PORT}`);
    console.log('='.repeat(50));
    console.log(`\n📌 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`📌 Get OTP:     http://localhost:${PORT}/otp`);
    console.log(`📌 Wait OTP:    http://localhost:${PORT}/otp/wait/120`);
    console.log(`📌 Health:      http://localhost:${PORT}/health`);
    console.log('\nKonfigurasi app forward notif di HP:');
    console.log('  URL: http://<IP_LAPTOP>:' + PORT + '/webhook');
    console.log('  Method: POST');
    console.log('  Body: JSON { "text": "...notifikasi...", "phone": "optional" }');
    console.log('\n🔔 Menunggu webhook...\n');
});
