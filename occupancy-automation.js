const { google } = require('googleapis');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const PDFParser = require('pdf-parse');

// Configuration
const TARGET_NUMBERS = [
  { number: '919810189884', name: 'Samit Jain' },
  { number: '919810659034', name: 'Rishi Jain' },
  { number: '917015937362', name: 'Mohit Jain' }
];

let sock;

// Initialize WhatsApp
async function initializeWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('📱 QR CODE GENERATED - Scan with WhatsApp');
    }
    
    if (connection === 'open') {
      console.log('✅ WhatsApp Connected!');
    }
    
    if (connection === 'close') {
      let shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(initializeWhatsApp, 3000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
  
  return new Promise((resolve) => {
    const checkConnection = setInterval(() => {
      if (sock.user) {
        clearInterval(checkConnection);
        resolve();
      }
    }, 1000);
    
    setTimeout(() => {
      clearInterval(checkConnection);
      resolve();
    }, 15000);
  });
}

// Get Gmail Client with Service Account
async function getGmailClient() {
  try {
    const serviceAccountJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountJson,
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly'
      ]
    });

    const authClient = await auth.getClient();
    return google.gmail({ version: 'v1', auth: authClient });
  } catch (error) {
    console.error('Gmail auth error:', error.message);
    throw error;
  }
}

// Extract PDF text
async function extractPDFText(pdfBuffer) {
  try {
    const data = await PDFParser(pdfBuffer);
    return data.text;
  } catch (error) {
    console.error('PDF parse error:', error);
    return '';
  }
}

// Parse occupancy data
function parseOccupancyData(pdfText) {
  const data = {
    roomsOccupied: null,
    roomsVacant: null,
    occupancyPercent: null,
    date: null,
    revenue: null
  };

  const dateMatch = pdfText.match(/Date\s*:\s*(\d{2}-\w{3}-\d{4})/);
  if (dateMatch) data.date = dateMatch[1];

  const occupiedMatch = pdfText.match(/Rooms\s+Occupied[^\d]*(\d+)/i);
  if (occupiedMatch) data.roomsOccupied = parseInt(occupiedMatch[1]);

  const vacantMatch = pdfText.match(/Rooms\s+Vacant[^\d]*(\d+)/i);
  if (vacantMatch) data.roomsVacant = parseInt(vacantMatch[1]);

  const occupancyMatch = pdfText.match(/Occupancy\s+%age[^\d]*(\d+)/i);
  if (occupancyMatch) data.occupancyPercent = parseInt(occupancyMatch[1]);

  const revenueMatch = pdfText.match(/Total\s+Revenue[^\d]*(\d+,?\d+)/);
  if (revenueMatch) data.revenue = revenueMatch[1];

  return data;
}

// Download PDF from Gmail
async function downloadLatestPDF() {
  try {
    const gmail = await getGmailClient();
    
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'subject:"Night Audit" has:attachment filename:pdf newer_than:1d',
      maxResults: 1
    });

    if (!response.data.messages || response.data.messages.length === 0) {
      console.log('❌ No Night Audit emails found');
      return null;
    }

    const messageId = response.data.messages[0].id;
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const parts = message.data.payload.parts || [];
    const pdfPart = parts.find(part => 
      part.filename && part.filename.toLowerCase().endsWith('.pdf')
    );

    if (!pdfPart) {
      console.log('❌ No PDF attachment found');
      return null;
    }

    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: messageId,
      id: pdfPart.body.attachmentId
    });

    const pdfBuffer = Buffer.from(attachment.data.data, 'base64');
    const pdfText = await extractPDFText(pdfBuffer);
    const occupancyData = parseOccupancyData(pdfText);

    console.log('✅ PDF parsed:', occupancyData);
    return occupancyData;

  } catch (error) {
    console.error('PDF download error:', error.message);
    return null;
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    if (!sock || !sock.user) {
      console.log('⚠️ WhatsApp not connected');
      return false;
    }

    const jid = phoneNumber + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Message sent to +${phoneNumber}`);
    return true;

  } catch (error) {
    console.error(`Error sending to ${phoneNumber}:`, error.message);
    return false;
  }
}

// Format message
function formatWhatsAppMessage(data) {
  if (!data.roomsOccupied) {
    return '❌ Could not parse occupancy data. Please check manually.';
  }

  const date = data.date || new Date().toLocaleDateString('en-GB');
  const occupied = data.roomsOccupied || 'N/A';
  const vacant = data.roomsVacant || 'N/A';
  const occupancy = data.occupancyPercent || 'N/A';
  const revenue = data.revenue || 'N/A';

  return `📊 *KAISONS INN - Daily Occupancy*

📅 Date: ${date}

🛏️ Rooms Occupied: ${occupied}
🏠 Rooms Vacant: ${vacant}
📈 Occupancy %: ${occupancy}%

💰 Total Revenue: ₹${revenue}

⏰ Report Time: ${new Date().toLocaleTimeString('en-IN')}`;
}

// Main
async function main() {
  console.log('🚀 Starting Occupancy Report Automation...');
  console.log('⏰ Time:', new Date().toLocaleString('en-IN'));
  
  try {
    console.log('\n📱 Initializing WhatsApp...');
    await initializeWhatsApp();
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('\n📥 Downloading PDF from Gmail...');
    const occupancyData = await downloadLatestPDF();

    if (!occupancyData) {
      console.log('❌ Failed to get occupancy data');
      process.exit(1);
    }

    const message = formatWhatsAppMessage(occupancyData);
    console.log('\n📨 Message:\n', message);

    console.log('\n📤 Sending WhatsApp messages...');
    for (const person of TARGET_NUMBERS) {
      await sendWhatsAppMessage(person.number, message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('\n✅ All messages sent!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  if (sock) await sock.end();
  process.exit(0);
});
