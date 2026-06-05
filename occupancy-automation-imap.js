const Imap = require('imap');
const { simpleParser } = require('mailparser');
const PDFParser = require('pdf-parse');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// Configuration
const TARGET_NUMBERS = [
  { number: '919810189884', name: 'Samit Jain' },
  { number: '919810659034', name: 'Rishi Jain' },
  { number: '917015937362', name: 'Mohit Jain' }
];

const GMAIL_USER = process.env.GMAIL_USER || 'kaisonsinn.nightaudit@gmail.com';
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD || '52@Jasola';

let sock;

// Logger
const logger = pino();

// Initialize WhatsApp connection
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
        console.log('🔄 Reconnecting WhatsApp...');
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

// Connect to Gmail via IMAP
function connectToGmail() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER,
      password: GMAIL_PASSWORD,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(imap);
    });

    imap.openBox('INBOX', false, (err) => {
      if (err) reject(err);
    });
  });
}

// Extract text from PDF Buffer
async function extractPDFText(pdfBuffer) {
  try {
    const data = await PDFParser(pdfBuffer);
    return data.text;
  } catch (error) {
    console.error('Error parsing PDF:', error);
    return '';
  }
}

// Parse occupancy data from PDF text
function parseOccupancyData(pdfText) {
  const data = {
    roomsOccupied: null,
    roomsVacant: null,
    occupancyPercent: null,
    date: null,
    revenue: null
  };

  // Extract date
  const dateMatch = pdfText.match(/Date\s*:\s*(\d{2}-\w{3}-\d{4})/);
  if (dateMatch) {
    data.date = dateMatch[1];
  }

  // Extract occupancy data
  const occupiedMatch = pdfText.match(/Rooms\s+Occupied[^\d]*(\d+)/i);
  if (occupiedMatch) {
    data.roomsOccupied = parseInt(occupiedMatch[1]);
  }

  const vacantMatch = pdfText.match(/Rooms\s+Vacant[^\d]*(\d+)/i);
  if (vacantMatch) {
    data.roomsVacant = parseInt(vacantMatch[1]);
  }

  const occupancyMatch = pdfText.match(/Occupancy\s+%age[^\d]*(\d+)/i);
  if (occupancyMatch) {
    data.occupancyPercent = parseInt(occupancyMatch[1]);
  }

  // Extract total revenue
  const revenueMatch = pdfText.match(/Total\s+Revenue[^\d]*(\d+,?\d+)/);
  if (revenueMatch) {
    data.revenue = revenueMatch[1];
  }

  return data;
}

// Download latest PDF from Gmail
async function downloadLatestPDF() {
  return new Promise(async (resolve, reject) => {
    try {
      const imap = await connectToGmail();

      // Search for emails with "Night Audit" in subject
      imap.search(['UNSEEN', 'SUBJECT', 'Night Audit'], (err, results) => {
        if (err) {
          imap.end();
          resolve(null);
          return;
        }

        if (!results || results.length === 0) {
          console.log('❌ No Night Audit emails found');
          imap.end();
          resolve(null);
          return;
        }

        const f = imap.fetch(results.slice(-1), { bodies: '' });

        f.on('message', (msg, seqno) => {
          let pdfBuffer = null;

          msg.on('body', (stream, info) => {
            simpleParser(stream, async (err, parsed) => {
              if (err) {
                console.error('Parse error:', err);
                return;
              }

              // Find PDF attachment
              if (parsed.attachments && parsed.attachments.length > 0) {
                const pdfAttachment = parsed.attachments.find(att => 
                  att.filename && att.filename.toLowerCase().endsWith('.pdf')
                );

                if (pdfAttachment) {
                  pdfBuffer = pdfAttachment.content;
                  const pdfText = await extractPDFText(pdfBuffer);
                  const occupancyData = parseOccupancyData(pdfText);
                  
                  console.log('✅ PDF parsed:', occupancyData);
                  imap.end();
                  resolve(occupancyData);
                }
              } else {
                console.log('❌ No PDF attachment found');
                imap.end();
                resolve(null);
              }
            });
          });
        });

        f.on('error', (err) => {
          console.error('Fetch error:', err);
          imap.end();
          resolve(null);
        });

        f.on('end', () => {
          // Don't close here, let the parser finish
        });
      });

      imap.on('error', (err) => {
        console.error('IMAP error:', err);
        imap.end();
        resolve(null);
      });

    } catch (error) {
      console.error('Error downloading PDF:', error.message);
      resolve(null);
    }
  });
}

// Send WhatsApp message
async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    if (!sock || !sock.user) {
      console.log('⚠️ WhatsApp not connected for', phoneNumber);
      return false;
    }

    const jid = phoneNumber + '@s.whatsapp.net';
    
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Message sent to +${phoneNumber}`);
    return true;

  } catch (error) {
    console.error(`❌ Error sending to ${phoneNumber}:`, error.message);
    return false;
  }
}

// Format WhatsApp message
function formatWhatsAppMessage(data) {
  if (!data.roomsOccupied) {
    return '❌ Could not parse occupancy data from report. Please check manually.';
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

// Main execution
async function main() {
  console.log('🚀 Starting Occupancy Report Automation...');
  console.log('📧 Email:', GMAIL_USER);
  console.log('⏰ Time:', new Date().toLocaleString('en-IN'));
  
  try {
    // Initialize WhatsApp
    console.log('\n📱 Initializing WhatsApp...');
    await initializeWhatsApp();
    
    // Wait for WhatsApp to connect
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    if (!sock?.user) {
      console.log('⚠️ WhatsApp connection timeout - proceeding anyway...');
    }

    // Download and parse PDF
    console.log('\n📥 Downloading PDF from Gmail...');
    const occupancyData = await downloadLatestPDF();

    if (!occupancyData) {
      console.log('❌ Failed to get occupancy data');
      process.exit(1);
    }

    // Format message
    const message = formatWhatsAppMessage(occupancyData);
    console.log('\n📨 Message to send:\n', message);

    // Send to all numbers
    console.log('\n📤 Sending WhatsApp messages...');
    for (const person of TARGET_NUMBERS) {
      await sendWhatsAppMessage(person.number, message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('\n✅ All messages sent successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error in main execution:', error);
    process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  if (sock) {
    await sock.end();
  }
  process.exit(0);
});
