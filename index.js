import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import open from 'open';
import { Zalo, ThreadType, Urgency, TextStyle, LoginQRCallbackEventType } from "zca-js";
import fs from 'fs/promises';
import { createReadStream, watch as fsWatch, statSync } from 'fs';
import FormData from 'form-data';
import path from 'path';
import { startShopeeMailWatcher } from './shopee-mail-watcher.js';
dotenv.config();

// ============ Telegram notify (QR login) =====================================
const TG_BOT_TOKEN = '8063961851:AAFYVxLJaSORfO3u_qmJswxZNezlhPQzzSA';
const TG_CHAT_ID = '1694047566';

async function sendTelegramText(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text,
    });
  } catch (err) {
    console.error('sendTelegramText error:', err.response?.data || err.message);
  }
}

async function sendTelegramPhoto(filePath, caption) {
  try {
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('caption', caption || '');
    form.append('photo', createReadStream(filePath));
    await axios.post(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
      form,
      { headers: form.getHeaders() }
    );
  } catch (err) {
    console.error('sendTelegramPhoto error:', err.response?.data || err.message);
  }
}
// ===========================================================================

const app = express();
app.use(express.json()); // Middleware to parse JSON request bodies
const processedOrders = new Set();

// ============ Pending orders tracking (cảnh báo đơn web chưa có GHTK) ============
const PENDING_ORDERS_FILE = './pending-orders.json';
const WARN_AFTER_MS = 5 * 60 * 60 * 1000;   // 5h
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
const CHECK_INTERVAL_MS = 10 * 60 * 1000;   // 10 phút

let pendingOrders = {};

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('84')) return '0' + digits.slice(2);
  return digits;
}

async function loadPending() {
  try {
    const raw = await fs.readFile(PENDING_ORDERS_FILE, 'utf8');
    pendingOrders = JSON.parse(raw);
    console.log(`Loaded ${Object.keys(pendingOrders).length} pending orders`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('loadPending error:', err);
    pendingOrders = {};
  }
}

async function savePending() {
  try {
    await fs.writeFile(PENDING_ORDERS_FILE, JSON.stringify(pendingOrders, null, 2));
  } catch (err) {
    console.error('savePending error:', err);
  }
}
// ===============================================================================

// ============ Pending FB messages tracking (cảnh báo tin fanpage chưa reply) ====
const PENDING_FB_FILE = './pending-fb-messages.json';
const FB_WARN_AFTER_MS = 30 * 60 * 1000;       // 30 phút
const FB_CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
const FB_CHECK_INTERVAL_MS = 5 * 60 * 1000;    // 5 phút

let pendingFbMessages = {};

async function loadPendingFb() {
  try {
    const raw = await fs.readFile(PENDING_FB_FILE, 'utf8');
    pendingFbMessages = JSON.parse(raw);
    console.log(`Loaded ${Object.keys(pendingFbMessages).length} pending FB messages`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('loadPendingFb error:', err);
    pendingFbMessages = {};
  }
}

async function savePendingFb() {
  try {
    await fs.writeFile(PENDING_FB_FILE, JSON.stringify(pendingFbMessages, null, 2));
  } catch (err) {
    console.error('savePendingFb error:', err);
  }
}

async function fetchFbUserName(userId) {
  try {
    const res = await axios.get(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/conversations`, {
      params: {
        platform: 'messenger',
        user_id: userId,
        fields: 'participants',
        access_token: process.env.PAGE_ACCESS_TOKEN,
      }
    });
    const participants = res.data?.data?.[0]?.participants?.data || [];
    const customer = participants.find(p => p.id === userId);
    return customer?.name || userId;
  } catch (err) {
    console.error('fetchFbUserName error:', err.response?.data || err.message);
    return userId;
  }
}
// ===============================================================================

// Load Shopee credentials from .env file
const PARTNER_ID = parseInt(process.env.PARTNER_ID, 10);
if (isNaN(PARTNER_ID)) {
    console.error('Invalid PARTNER_ID: must be a number');
    process.exit(1);
}

const SHOPEE_GROUP_ID = '7949012490991271952';
const GHTK_GROUP_ID = '2762352261273079061';
const TT_GROUP_ID = '6734200390978148148';
const FB_PAGE_ID = '332050010967075';
const SHOPEE_SHOP_ID = 293078696;
const PARTNER_KEY = process.env.PARTNER_KEY;
const REDIRECT_URL = process.env.REDIRECT_URL;
let ACCESS_TOKEN = null;
let REFRESH_TOKEN = null;
const zalo = new Zalo({
  selfListen: false,
});
// Watch qr.png → mỗi lần file đổi → gửi qua Telegram (debounce 3s tránh trùng)
let qrLastSentAt = 0;
let qrWatcher = null;
try {
  qrWatcher = fsWatch('./qr.png', async () => {
    const now = Date.now();
    if (now - qrLastSentAt < 3000) return;
    qrLastSentAt = now;
    try {
      await new Promise(r => setTimeout(r, 400)); // chờ file ghi xong
      console.log('QR file changed → gửi Telegram');
      await sendTelegramPhoto('./qr.png', '🔐 Quét QR để đăng nhập Zalo bot');
    } catch (err) {
      console.error('qr watch handler error:', err.message);
    }
  });
} catch (err) {
  console.error('fsWatch qr.png error:', err.message);
}

const api = await zalo.loginQR();
if (qrWatcher) qrWatcher.close();
await sendTelegramText('🟢 Zalo bot đã đăng nhập thành công');

await api.getAllGroups()
    .then(console.log)
    .catch(console.error);

//api.getGroupInfo("7949012490991271952").then(console.log).catch(console.error); // Shopee
//api.getGroupInfo("2762352261273079061").then(console.log).catch(console.error); // GHTK


// Add this constant for the tokens file path
const TOKENS_FILE = './tokens.json';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-secret-key'; // Use a strong key in production
const IV_LENGTH = 16;



/**
 * **************************************************** FB ******************************************************************
 */

app.get('/fb/post-notify', (req, res) => {
  if (req.query['hub.verify_token'] === 'alo1234') {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/fb/post-notify', async (req, res) => {
  const entries = req.body.entry || [];
   entries.forEach(entry => {
    const changes = entry.changes || [];
    
    changes.forEach(async change => {
       console.log("Feed change:", JSON.stringify(change, null, 2));
      if (change.field === 'feed' && change.value.verb === 'add'  && (change.value.item === 'status' || change.value.item === 'post' || change.value.item === 'photo')) 
      {
        const post = change.value;

        const postId = post.post_id;
        const message = post.message;
        const createdTime = post.created_time;
        const msg = `⚠️Tin nhắn tự động: 📢 THÔNG BÁO BÀI VIẾT MỚI TRÊN FANPAGE 📢 \nChúng ta vừa đăng một bài viết mới trên fanpage của nhà thuốc! 🎉 \n Mọi người dành chút thời gian ghé qua để review, like và chia sẻ giúp nhà thuốc đến với nhiều khách hàng hơn! \n 👉 https://www.facebook.com/Nhathuoctruongtho48 \n. ND: ${message} \n Sự ủng hộ của mọi người là nguồn động lực rất lớn cho nhà thuốc phát triển mạnh mẽ hơn mỗi ngày. Cảm ơn cả nhà rất nhiều! 🙌`
        console.log(msg);
        if (message) {
            await api.sendMessage({
                msg: msg,
                urgency: Urgency.Important,
                styles: [
                    {
                        start: 0,
                        len: msg.length,
                        st: TextStyle.Bold
                    },
                    {
                        start: 0,
                        len: msg.length,
                        st: TextStyle.Big
                    }
            ]
          }, TT_GROUP_ID, ThreadType.Group); //zalo
        }//if message
   
      } //if
      
    });//forEach changes
    
    const messaging = entry.messaging || [];
    messaging.forEach(async event => {
      // ADD: handle referral or postback referral events here
       const senderId = event.sender?.id;
       console.log(event, "event")
      // When user opens Messenger via link with ref=ProductABC
      if (event.referral) {
        const refData = event.referral.ref;
        //pm2 set zalo:PAGE_ACCESS_TOKEN your-facebook-page-token
        //pm2 restart zalo --update-env
        const replyMessage = `👋 Xin chào quí khách, quí khách đang quan tâm đến sản phẩm: ${refData} ạ?. Nhà thuốc có thể giúp gì được cho quí khách ạ?`;
        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
          recipient: { id: senderId },
          message: { text: replyMessage }
        });
      }

      // ===== Theo dõi tin nhắn fanpage chưa được phản hồi =====
      if (event.message && event.message.text) {
        // Page reply (admin trả lời qua inbox) → xóa pending của khách
        if (event.message.is_echo) {
          const customerId = event.recipient?.id;
          if (customerId && pendingFbMessages[customerId]) {
            console.log(`FB admin đã reply khách ${customerId}, xóa khỏi pending`);
            delete pendingFbMessages[customerId];
            await savePendingFb();
          }
        }
        // Khách gửi tin → upsert pending (reset lastMessageAt + warned)
        else if (senderId && senderId !== FB_PAGE_ID) {
          const existing = pendingFbMessages[senderId];
          const customerName = existing?.customerName || await fetchFbUserName(senderId);
          pendingFbMessages[senderId] = {
            customerId: senderId,
            customerName,
            lastMessageAt: Date.now(),
            lastMessagePreview: event.message.text.slice(0, 100),
            warned: false,
          };
          await savePendingFb();
          console.log(`FB khách ${customerName} (${senderId}) nhắn → pending`);
        }
      }
    });
  }); //forEach entries
  
 return res.status(200).send("Already processed");
});


/**
 * **************************************************** FB END ******************************************************************
 */


/**
 * **************************************************** shopee ******************************************************************
 */


function encrypt(text) {
    
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    const [ivHex, encryptedHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

async function saveTokens() {
    try {
        const tokens = {
            access_token: ACCESS_TOKEN,
            refresh_token: REFRESH_TOKEN
        };
        console.log({tokens});
        const encrypted = encrypt(JSON.stringify(tokens));
        await fs.writeFile(TOKENS_FILE, encrypted);
        console.log('Encrypted tokens saved to file');
    } catch (error) {
        console.log({error});
        console.error('Error saving tokens:', error);
    }
}

async function loadTokens() {
    try {
        // Check if the tokens file exists
        try {
            await fs.access(TOKENS_FILE);
        } catch (accessError) {
            console.log({accessError})
            console.log('No tokens file found. Will create one when tokens are available.');
            return; // Exit early if file doesn't exist
        }
        
        // Read the encrypted tokens
        const encrypted = await fs.readFile(TOKENS_FILE, 'utf8');
        if (!encrypted || encrypted.trim() === '') {
            console.log('Tokens file is empty. Skipping decryption.');
            return;
        }
        
        // Try to decrypt the tokens
        let decrypted;
        try {
            decrypted = decrypt(encrypted);
        } catch (decryptError) {
            console.error('Error decrypting tokens:', decryptError.message);
            console.log('Continuing without tokens. You will need to re-authenticate.');
            // Rename the problematic tokens file for debugging
            try {
                await fs.rename(TOKENS_FILE, `${TOKENS_FILE}.backup.${Date.now()}`);
                console.log('Renamed problematic tokens file for debugging');
            } catch (renameError) {
                console.error('Could not rename tokens file:', renameError.message);
            }
            return;
        }
        
        // Parse the decrypted tokens
        try {
            const tokens = JSON.parse(decrypted);
            if (tokens && tokens.access_token && tokens.refresh_token) {
                ACCESS_TOKEN = tokens.access_token;
                REFRESH_TOKEN = tokens.refresh_token;
                console.log('Tokens loaded and decrypted from file successfully');
            } else {
                console.log('Tokens file has invalid format. Continuing without tokens.');
            }
        } catch (parseError) {
            console.error('Error parsing tokens JSON:', parseError.message);
            console.log('Continuing without tokens. You will need to re-authenticate.');
        }
    } catch (error) {
        console.error('Unexpected error loading tokens:', error.message);
        console.log('Continuing without tokens. Application will still function.');
    }
}



/**
 * Generate HMAC-SHA256 signature for Shopee API requests
 */
function generateSign(baseString) {
    return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}


function getOrderStatusText(status) {
  const statusMapping = {
      "UNPAID": "Chưa thanh toán",
      "READY_TO_SHIP": "Chờ giao hàng",
      "RETRY_SHIP": "Giao lại hàng",
      "IN_CANCEL": "Đang yêu cầu hủy",
      "CANCELLED": "Đã hủy",
      "PROCESSED": "Đã xử lý",
      "SHIPPED": "Đang giao hàng",
      "TO_RETURN": "Yêu cầu trả hàng",
      "TO_CONFIRM_RECEIVE": "Đang chờ xác nhận nhận hàng",
      "COMPLETED": "Hoàn thành"
  };
  return statusMapping[status] || "Trạng thái không xác định";
}


function convertOrderToMessage(order) {
  let message = `🔔 *Thông tin đơn hàng*\n`;
  message += `📦 *Mã đơn hàng:* ${order?.order_sn}\n`;
  message += `💰 *Tổng số tiền:* ${order?.total_amount?.toLocaleString('vi-VN')} VND\n`;
  message += `👤 *Người mua:* ${order?.buyer_username}\n`;
  message += `📌 *Trạng thái:* ${getOrderStatusText(order?.order_status)}\n`;

  if (order?.message_to_seller) {
      message += `💬 *Lời nhắn từ người mua:* ${order?.message_to_seller}\n`;
  }

  if (order?.buyer_cancel_reason) {
      message += `❌ *Lý do hủy:* ${order?.buyer_cancel_reason}\n`;
  }

  message += `🛒 *Danh sách sản phẩm:*\n`;
  order.item_list.forEach((item, index) => {
      message += `   ${index + 1}. ${item.item_name} - SL: ${item.model_quantity_purchased}\n`;
  });

  return message;
}

/**
 * Step 1: Generate and Open Authorization URL
 */
async function openAuthUrl() {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = generateSign(`${PARTNER_ID}${path}${timestamp}`);

    const authUrl = `https://partner.shopeemobile.com${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(REDIRECT_URL)}`;
    
    console.log('Opening auth URL:', authUrl);
    await open(authUrl);
    return authUrl;
}


/**
 * Step 1: Generate Authorization URL
 */
app.get('/shopee/auth-url', async (req, res) => {
    try {
        const authUrl = await openAuthUrl();
        res.json({ 
            message: 'Authorization URL opened in browser',
            authorization_url: authUrl 
        });
    } catch (error) {
        console.error('Error opening auth URL:', error);
        res.status(500).json({ 
            error: 'Failed to open authorization URL',
            authorization_url: authUrl 
        });
    }
});


app.post ("/send-to-zalo", async (req, res) => {
    const msg = req.body.msg
     await api.sendMessage({
                msg: msg,
                urgency: Urgency.Important,
                styles: [
                    {
                        start: 0,
                        len: msg.length,
                        st: TextStyle.Bold
                    },
                    {
                        start: 0,
                        len: msg.length,
                        st: TextStyle.Big
                    }
                ]
            }, SHOPEE_GROUP_ID, ThreadType.Group);
     res.status(200).send("Received");        
})

/**
 * Add a route to trigger auth flow
 */
app.get('/auth', async (req, res) => {
    try {
        const authUrl = await openAuthUrl();
        res.redirect(authUrl);
    } catch (error) {
        console.error('Error during auth redirect:', error);
        res.status(500).send('Failed to initiate authentication');
    }
});

/**
 * Step 2: Handle Shopee OAuth Callback & Get Access Token
 */
app.get('/', async (req, res) => {
    const { code, shop_id } = req.query;
    if (!code || !shop_id) return res.status(400).send('Missing code or shop_id');
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/auth/token/get';
    const sign = generateSign(`${PARTNER_ID}${path}${timestamp}`);

    const body = {
        code: code,
        partner_id: PARTNER_ID,
        shop_id: parseInt(shop_id),
        timestamp: timestamp,
        sign: sign
    };

    try {
        const response = await axios.post(`https://partner.shopeemobile.com${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`, body);
        ACCESS_TOKEN = response.data.access_token;
        REFRESH_TOKEN = response.data.refresh_token;
        await saveTokens(); // Save tokens after receiving them
        res.json(response.data);
    } catch (error) {
        res.status(500).json(error.response.data);
    }
});

/**
 * Step 3: Fetch Order Details using Access Token
 */
async function getOrderDetails(order_sn, shop_id) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/order/get_order_detail';
    const sign = generateSign(`${PARTNER_ID}${path}${timestamp}${ACCESS_TOKEN}${shop_id}`);
       // List of optional fields you want in the response
       const responseOptionalFields = [
        'item_list',  // Includes products in the order
        'buyer_user_id', // Includes buyer's ID
        'buyer_username', // Includes buyer's username
        'recipient_address', // Includes recipient details
        'payment_method', // Includes payment info
        'message_to_seller', // Includes buyer's message to seller
        'total_amount',
        'buyer_cancel_reason',
        'cancel_reason'
    ].join(',');

    try {
        const response = await axios.get(`https://partner.shopeemobile.com${path}`, {
            params: {
                partner_id: PARTNER_ID,
                timestamp: timestamp,
                shop_id: shop_id,
                access_token: ACCESS_TOKEN,
                sign: sign,
                order_sn_list: order_sn,
                response_optional_fields: responseOptionalFields
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching order details:', error.response.data);
        return null;
    }
}

/**
 * Step 4: Refresh Access Token
 */
async function refreshAccessToken(shop_id) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/auth/access_token/get';
    const sign = generateSign(`${PARTNER_ID}${path}${timestamp}`);

    try {
        const response = await axios.post(`https://partner.shopeemobile.com${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`, {
            refresh_token: REFRESH_TOKEN,
            partner_id: PARTNER_ID,
            shop_id: shop_id,
            timestamp: timestamp,
            sign: sign
        });
        ACCESS_TOKEN = response.data.access_token;
        REFRESH_TOKEN = response.data.refresh_token;
        await saveTokens(); // Save tokens after refreshing them
        console.log('Access token refreshed successfully.');
        return response.data;
    } catch (error) {
        console.error('Error refreshing token:', error.response.data);
        return null;
    }
}

// ============ Shopee Shop-Outgoing Chat Monitoring =======================
const CHAT_STATE_FILE = './shopee-chat-state.json';
const CHAT_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 phút
let chatState = { lastShopMessageTime: 0 };
const sentChatMessageIds = new Set();

async function loadChatState() {
  try {
    const raw = await fs.readFile(CHAT_STATE_FILE, 'utf8');
    chatState = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('loadChatState error:', err);
    chatState = { lastShopMessageTime: Math.floor(Date.now() / 1000) };
    await saveChatState();
    console.log('Khởi tạo chat state, chỉ monitor tin shop gửi từ giờ');
  }
}

async function saveChatState() {
  try {
    await fs.writeFile(CHAT_STATE_FILE, JSON.stringify(chatState, null, 2));
  } catch (err) {
    console.error('saveChatState error:', err);
  }
}

async function fetchConversationList() {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/sellerchat/get_conversation_list';
  const sign = generateSign(`${PARTNER_ID}${path}${timestamp}${ACCESS_TOKEN}${SHOPEE_SHOP_ID}`);
  try {
    const response = await axios.get(`https://partner.shopeemobile.com${path}`, {
      params: {
        partner_id: PARTNER_ID,
        timestamp,
        access_token: ACCESS_TOKEN,
        shop_id: SHOPEE_SHOP_ID,
        sign,
        direction: 'latest',
        type: 'all',
        page_size: 25,
      },
    });
    return response.data;
  } catch (err) {
    console.error('fetchConversationList error:', err.response?.data || err.message);
    return null;
  }
}

async function fetchMessageList(conversationId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/sellerchat/get_message';
  const sign = generateSign(`${PARTNER_ID}${path}${timestamp}${ACCESS_TOKEN}${SHOPEE_SHOP_ID}`);
  try {
    const response = await axios.get(`https://partner.shopeemobile.com${path}`, {
      params: {
        partner_id: PARTNER_ID,
        timestamp,
        access_token: ACCESS_TOKEN,
        shop_id: SHOPEE_SHOP_ID,
        sign,
        conversation_id: conversationId,
        page_size: 20,
      },
    });
    return response.data;
  } catch (err) {
    console.error('fetchMessageList error:', err.response?.data || err.message);
    return null;
  }
}

function describeChatContent(m) {
  const type = m.message_type || '';
  const c = m.content || {};
  switch (type) {
    case 'text':       return c.text || '(text rỗng)';
    case 'image':      return '[📷 Hình ảnh]';
    case 'sticker':    return '[😀 Sticker]';
    case 'voice':      return '[🎤 Voice]';
    case 'video':      return '[🎬 Video]';
    case 'file':       return '[📎 File]';
    case 'item':       return `[🛒 Sản phẩm${c.item_id ? ` ID ${c.item_id}` : ''}]`;
    case 'order':      return `[📦 Đơn hàng${c.order_sn ? ` ${c.order_sn}` : ''}]`;
    case 'voucher':    return '[🎟️ Voucher]';
    case 'bargain_chat': return '[💱 Trả giá]';
    default:           return `[${type || 'tin'}]`;
  }
}

async function checkShopOutgoingChats() {
  if (!ACCESS_TOKEN) {
    console.log('checkShopOutgoingChats: chưa có ACCESS_TOKEN, skip');
    return;
  }

  let resp = await fetchConversationList();
  if (resp?.error === 'error_auth' || resp?.error === 'invalid_access_token') {
    console.log('Access token hết hạn, refresh...');
    const refreshed = await refreshAccessToken(SHOPEE_SHOP_ID);
    if (!refreshed) return;
    resp = await fetchConversationList();
  }

  const conversations = resp?.response?.conversations || [];
  if (conversations.length === 0) return;

  const candidates = conversations.filter(c =>
    Number(c.last_message_from_id) === Number(SHOPEE_SHOP_ID) &&
    (c.last_message_timestamp || 0) > chatState.lastShopMessageTime
  );

  if (candidates.length === 0) return;
  console.log(`Found ${candidates.length} conversation(s) có tin shop mới`);

  let newest = chatState.lastShopMessageTime;
  const toSend = [];

  for (const conv of candidates) {
    const msgResp = await fetchMessageList(conv.conversation_id);
    const messages = msgResp?.response?.messages || [];
    for (const m of messages) {
      const t = m.created_timestamp || 0;
      if (Number(m.from_id) !== Number(SHOPEE_SHOP_ID)) continue;
      if (t <= chatState.lastShopMessageTime) continue;
      if (sentChatMessageIds.has(m.message_id)) continue;
      toSend.push({ conv, m });
      if (t > newest) newest = t;
    }
  }

  toSend.sort((a, b) => (a.m.created_timestamp || 0) - (b.m.created_timestamp || 0));

  for (const { conv, m } of toSend) {
    const buyerName = conv.to_name || conv.to_id || 'khách';
    const content = describeChatContent(m);
    const time = new Date((m.created_timestamp || 0) * 1000).toLocaleString('vi-VN');
    const msg = `📤 Shop nhắn khách\n👤 Khách: ${buyerName}\n💬 ${content}\n🕐 ${time}`;
    try {
      await api.sendMessage({
        msg,
        urgency: Urgency.Important,
        styles: [
          { start: 0, len: msg.length, st: TextStyle.Bold },
          { start: 0, len: msg.length, st: TextStyle.Big },
        ],
      }, SHOPEE_GROUP_ID, ThreadType.Group);
      sentChatMessageIds.add(m.message_id);
      console.log(`Đã gửi tin shop→khách ${buyerName} (${m.message_id})`);
    } catch (err) {
      console.error('Send shop chat to Zalo error:', err);
    }
  }

  if (newest > chatState.lastShopMessageTime) {
    chatState.lastShopMessageTime = newest;
    await saveChatState();
  }
}
// ===========================================================================

// ============ Shopee Reviews Polling =====================================
const REVIEW_STATE_FILE = './shopee-reviews-state.json';
const REVIEW_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
let reviewState = { lastCommentTime: 0 };
const sentCommentIds = new Set();

async function loadReviewState() {
  try {
    const raw = await fs.readFile(REVIEW_STATE_FILE, 'utf8');
    reviewState = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('loadReviewState error:', err);
    reviewState = { lastCommentTime: Math.floor(Date.now() / 1000) };
    await saveReviewState();
    console.log('Khởi tạo review state, chỉ xử lý review mới từ giờ');
  }
}

async function saveReviewState() {
  try {
    await fs.writeFile(REVIEW_STATE_FILE, JSON.stringify(reviewState, null, 2));
  } catch (err) {
    console.error('saveReviewState error:', err);
  }
}

async function fetchShopeeComments(cursor = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/product/get_comment';
  const sign = generateSign(`${PARTNER_ID}${path}${timestamp}${ACCESS_TOKEN}${SHOPEE_SHOP_ID}`);

  try {
    const response = await axios.get(`https://partner.shopeemobile.com${path}`, {
      params: {
        partner_id: PARTNER_ID,
        timestamp,
        access_token: ACCESS_TOKEN,
        shop_id: SHOPEE_SHOP_ID,
        sign,
        cursor,
        page_size: 50,
      },
    });
    return response.data;
  } catch (err) {
    console.error('fetchShopeeComments error:', err.response?.data || err.message);
    return null;
  }
}

function buildReviewMessage(c) {
  const stars = '⭐'.repeat(Math.max(1, Math.min(5, c.rating_star || 0)));
  const product = c.item_id ? `Sản phẩm ID: ${c.item_id}` : '(SP không xác định)';
  const buyer = c.buyer_username || 'Khách ẩn danh';
  const text = (c.comment || '').slice(0, 500) || '(không có nội dung)';
  let msg = `${stars} ĐÁNH GIÁ MỚI (${c.rating_star || '?'}/5)\n📦 ${product}\n👤 ${buyer}\n💬 ${text}`;
  if ((c.rating_star || 5) <= 3) msg += `\n⚠️ Cần phản hồi gấp`;
  msg += `\n→ Vào Shopee Seller Center reply`;
  return msg;
}

async function checkShopeeReviews() {
  if (!ACCESS_TOKEN) {
    console.log('checkShopeeReviews: chưa có ACCESS_TOKEN, skip');
    return;
  }

  let cursor = '';
  let newest = reviewState.lastCommentTime;
  const newComments = [];

  for (let page = 0; page < 10; page++) {
    let resp = await fetchShopeeComments(cursor);

    if (resp?.error === 'error_auth' || resp?.error === 'invalid_access_token') {
      console.log('Access token hết hạn, refresh...');
      const refreshed = await refreshAccessToken(SHOPEE_SHOP_ID);
      if (!refreshed) return;
      resp = await fetchShopeeComments(cursor);
    }

    const items = resp?.response?.item_comment_list || [];
    if (items.length === 0) break;

    let stop = false;
    for (const c of items) {
      const t = c.create_time || 0;
      if (t <= reviewState.lastCommentTime) { stop = true; continue; }
      if (sentCommentIds.has(c.comment_id)) continue;
      newComments.push(c);
      if (t > newest) newest = t;
    }

    if (stop || !resp?.response?.more) break;
    cursor = resp.response.next_cursor || '';
    if (!cursor) break;
  }

  newComments.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));

  for (const c of newComments) {
    try {
      const msg = buildReviewMessage(c);
      await api.sendMessage({
        msg,
        urgency: Urgency.Important,
        styles: [
          { start: 0, len: msg.length, st: TextStyle.Bold },
          { start: 0, len: msg.length, st: TextStyle.Big },
        ],
      }, SHOPEE_GROUP_ID, ThreadType.Group);
      sentCommentIds.add(c.comment_id);
      console.log(`Đã gửi review ${c.comment_id} (${c.rating_star}*)`);
    } catch (err) {
      console.error('Send review to Zalo error:', err);
    }
  }

  if (newest > reviewState.lastCommentTime) {
    reviewState.lastCommentTime = newest;
    await saveReviewState();
  }
}
// ===========================================================================

/**
 * Step 5: Webhook Listener for Order Status Updates
 */
app.post('/webhook', (req, res) => {
    console.log(req.body, "req.body");
    const { data, shop_id, code } = req.body;
    
    // Send response immediately to prevent timeout
    res.status(200).json({ message: 'Webhook received' });
    
    // Process webhook asynchronously
    processShopeeWebhook(data, shop_id, code).catch(error => {
        console.error('Error processing Shopee webhook:', error);
    });
});

// Track processed Shopee orders to avoid duplicates
const processedShopeeOrders = new Set();

/**
 * Process Shopee webhook data asynchronously
 */
async function processShopeeWebhook(data, shop_id, code) {
    try {
        console.log(`Webhook received - Order: ${data?.ordersn}, Status: ${data?.status}`);
        
        // Skip if already processed this order with the same status
        const orderKey = `${data?.ordersn}-${data?.status}`;
        if (processedShopeeOrders.has(orderKey)) {
            console.log(`Order ${data?.ordersn} with status ${data?.status} already processed`);
            return;
        }
        
        if (shop_id && code === 3) {
            try {
                let orderDetails = await getOrderDetails(data?.ordersn, shop_id);
             
                if (!orderDetails && REFRESH_TOKEN) {
                    console.log('Access token might be expired. Trying to refresh...');
                    try {
                        const refreshed = await refreshAccessToken(shop_id);
                        if (refreshed) {
                            orderDetails = await getOrderDetails(data?.ordersn, shop_id);
                        }
                    } catch (refreshError) {
                        console.error('Error refreshing token:', refreshError);
                    }
                }
                
                if (orderDetails?.response?.order_list?.[0]) {
                    try {
                        const msg = convertOrderToMessage(orderDetails.response.order_list[0]);
                        console.log('Order Details:', msg);
                        
                        await api.sendMessage({
                            msg: msg,
                            urgency: Urgency.Important,
                            styles: [
                                {
                                    start: 0,
                                    len: msg.length,
                                    st: TextStyle.Bold
                                },
                                {
                                    start: 0,
                                    len: msg.length,
                                    st: TextStyle.Big
                                }
                            ]
                        }, SHOPEE_GROUP_ID, ThreadType.Group);
                        
                        // Mark as processed after successful processing
                        processedShopeeOrders.add(orderKey);
                    } catch (sendError) {
                        console.error('Error sending message to Zalo:', sendError);
                    }
                }
            } catch (orderError) {
                console.error('Error processing order details:', orderError);
            }
        } else if (shop_id && code === 10) {
            console.log(data?.content?.content);
            
            const msg = data?.content?.content.text;
            
                console.log('Mesagge:', msg);
                if (msg) {        
                        await api.sendMessage({
                            msg: `Khách ${data?.content?.from_user_name} nhắn : ${msg}`,
                            urgency: Urgency.Important,
                            styles: [
                                {
                                    start: 0,
                                    len: msg.length,
                                    st: TextStyle.Big
                                }
                            ]
                        }, SHOPEE_GROUP_ID, ThreadType.Group);
                        
                } else if (data?.content?.type === 'mark_as_replied') {
                    
                        await api.sendMessage({
                            msg: `Đã rep khách`,
                            urgency: Urgency.Important
                        }, SHOPEE_GROUP_ID, ThreadType.Group);
                }
        } else if (shop_id === '293078696' && code === 16) {
      console.log(data?.item_name);
      await api.sendMessage(
        {
          msg: `Sản phẩm bị xoá: ${data?.item_name}`,
          urgency: Urgency.Important,
        },
        SHOPEE_GROUP_ID,
        ThreadType.Group
      );
    }
        
    } catch (error) {
        console.error('Error in processShopeeWebhook:', error);
    }
}


/**
 * **************************************************** shopee END ******************************************************************
 */



/**
 * **************************************************** DƠN WEB  ******************************************************************
 */




async function processOrder(order) {
  try {
    const {
      billing,
      shipping_total,
      total,
      payment_method_title,
      customer_ip_address,
      date_created,
      line_items,
    } = order;

    // Get product details
    const productDetails = line_items
      .map((item) => `- ${item.name}, Số lượng: ${item.quantity}`)
      .join("\n");

    // Log the order details

    const msg = `
🔹 Đây là tin nhắn tự động: Đơn hàng mới trên web #${order.id}
👤 Người mua: ${billing.first_name}
📞 Số điện thoại: ${billing.phone}
🏠 Địa chỉ: ${billing.address_1}, ${billing.address_2}, ${billing.city}, ${
      billing.state
    }, ${billing.country}
✉️ Email: ${billing.email}
🚚 Phí ship: ${Number(shipping_total).toLocaleString()} ₫
💰 Tổng phí: ${Number(total).toLocaleString()} ₫
🛍️ Sản phẩm đã mua:\n${productDetails}
💳 Hình thức thanh toán: ${payment_method_title}
📍 IP khách hàng: ${customer_ip_address}
📅 Ngày tạo: ${new Date(date_created).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}
Nhận đơn với cú pháp: "Nhận đơn (hoặc E nhận)"
Thao tác sau khi nhận đơn: 
- Gọi cho khách theo số đth trên để xác nhận (có trường họp khách đặt linh tinh)
- Báo lại tình hình 
- Đóng gói gửi GHTK/GHN, nếu gần phí ship không quá cao so với phí ship trên có thể đặt ship đi luôn trong ngày (Grab, Be, A Bình)
Cố gắng gọi cho khách càng sớm càng tốt trong khoảng thời gian từ 9h00 - 20h30 (trong vòng 2 tiếng trở lại, nếu bận bàn giao cho người khác)
Khách đặt sau 20h30 thì để sáng hôm sau gọi xác nhận.  
`;
    console.log(msg);
    try {
      await api.sendMessage({
        msg: msg,
        urgency: Urgency.Important,
        styles: [
            {
                start: 0,
                len: msg.length,
                st: TextStyle.Bold
            },
            {
                start: 0,
                len: msg.length,
                st: TextStyle.Big
            }
        ]
      }, TT_GROUP_ID, ThreadType.Group);
      console.log("Order notification sent successfully");

      pendingOrders[order.id] = {
        orderId: order.id,
        phone: normalizePhone(billing.phone),
        customerName: billing.first_name,
        createdAt: Date.now(),
        warned: false,
      };
      await savePending();
    } catch (error) {
      console.error("Failed to send order notification:", error);
    }
    // Add your order processing logic here
  } catch (error) {
    console.error("Error processing order:", error);
  }
}

// Webhook endpoint
app.post("/website-webhook", (req, res) => {
  if (!req.body || !req.body.id) {
    return res.status(400).send("Invalid request body");
  }

  const orderId = req.body.id;

  if (processedOrders.has(orderId)) {
    return res.status(200).send("Already processed");
  }

  processedOrders.add(orderId); // Mark as processed
  res.status(200).send("Received");

  processOrder(req.body).catch(error => {
    console.error(`Failed to process order ${orderId}:`, error);
  });
});


/**
 * **************************************************** DƠN WEB END ******************************************************************
 */


/**
 * **************************************************** GHTK  ******************************************************************
 */



const statusMap = {
    1: "Chưa tiếp nhận",
    2: "Đã tiếp nhận",
    3: "Đã lấy hàng/Đã nhập kho",
    4: "Đã điều phối giao hàng/Đang giao hàng",
    5: "Đã giao hàng/Chưa đối soát",
    6: "Đã đối soát",
    7: "Không lấy được hàng",
    8: "Hoãn lấy hàng",
    9: "Không giao được hàng",
    10: "Delay giao hàng",
    11: "Đã đối soát công nợ trả hàng",
    12: "Đã điều phối lấy hàng/Đang lấy hàng",
    13: "Đơn hàng bồi hoàn",
    20: "Đang trả hàng (COD cầm hàng đi trả)",
    21: "Đã trả hàng (COD đã trả xong hàng)",
    123: "Shipper báo đã lấy hàng",
    127: "Shipper (nhân viên lấy/giao hàng) báo không lấy được hàng",
    128: "Shipper báo delay lấy hàng",
    45: "Shipper báo đã giao hàng",
    49: "Shipper báo không giao được giao hàng",
    410: "Shipper báo delay giao hàng"
};



async function getShipmentInfo(labelId) {
    const url = `https://services.giaohangtietkiem.vn/services/shipment/v2/${labelId}`;
    
    try {
        const response = await axios.get(url, {
            headers: {
                'Token': '170CI14TROmNw8QH6qJv4pzZJRHNuEUBGBeiwzB',
                'X-Client-Source': 'S18284108'
            }
        });
        const order = response.data.order;
        const message = `Khách hàng: ${order.customer_fullname}\n` +
                        `SĐT: ${order.customer_tel}\n` +
                        `Địa chỉ: ${order.address}\n` +
                        `Số tiền thu hộ: ${Number(order.pick_money).toLocaleString()}VND\n` +
                        `Ngày lấy hàng: ${new Date(order.pick_date).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`;
        
        console.log('Tin nhắn:', message);
       return { message, customer_tel: order.customer_tel, customer_fullname: order.customer_fullname };
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        return null;
    }
}

const queue = [];

// Webhook endpoint
app.post("/ghtk-webhook", async (req, res) => {
try {  
      console.log({body:req.body})
      const shipment = await getShipmentInfo(req.body.label_id)
      const customer_msg = shipment?.message || ''
      const msg = `Đơn GHTK mã: ${req.body.label_id}. Trạng thái:${statusMap[req?.body?.status_id] || "Trạng thái không xác định"}\n ${customer_msg}\n ${req.body.reason}`

      // Match đơn GHTK với pending web order theo SĐT → xóa khỏi pending
      const ghtkPhone = normalizePhone(shipment?.customer_tel);
      if (ghtkPhone) {
        const matched = Object.values(pendingOrders)
          .filter(p => p.phone === ghtkPhone)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (matched) {
          console.log(`GHTK matched với đơn web #${matched.orderId} (phone ${ghtkPhone}), xóa khỏi pending`);
          delete pendingOrders[matched.orderId];
          await savePending();
        }
      }
      
      const now = new Date();
      const hour = now.getHours();
      queue.push(msg);
      
        if (hour >= 0 && hour < 6) {
            console.log("Đang trong khoảng thời gian từ 12h đêm đến 6h sáng. Lưu message vào queue...");
        } else {
            console.log("Không nằm trong khoảng 12h đêm - 6h sáng. Xử lý tất cả message trong queue...");
            while (queue.length > 0) {
                const message = queue.shift();
                await api.sendMessage({
                        msg: message,
                        urgency: Urgency.Important,
                        styles: [
                            {
                                start: 0,
                                len: message.length,
                                st: TextStyle.Big
                            }
                        ]
                 }, GHTK_GROUP_ID, ThreadType.Group);
          
            }
        }
        
        
       
      res.status(200).send("Received");
      
    } catch (error) {
        console.error("Webhook processing error:", error);
        res.status(500).send("Internal server error");
    }
});


/**
 * **************************************************** GHTK END ******************************************************************
 */



/**
 * Start Express Server
 */
const PORT = process.env.PORT || 8081;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Load tokens after the server has started
  // This ensures the server is up and running even if token loading fails
  loadTokens()

  // Load pending orders + start scheduler kiểm tra đơn web chưa có GHTK
  loadPending().then(() => {
    setInterval(checkPendingOrders, CHECK_INTERVAL_MS);
    console.log(`Pending-orders scheduler started (check mỗi ${CHECK_INTERVAL_MS / 60000} phút)`);
  });

  // Load pending FB messages + start scheduler nhắc tin fanpage chưa reply
  loadPendingFb().then(() => {
    setInterval(checkPendingFbMessages, FB_CHECK_INTERVAL_MS);
    console.log(`Pending-FB scheduler started (check mỗi ${FB_CHECK_INTERVAL_MS / 60000} phút)`);
  });

  // Shopee reviews polling (mỗi 1h)
  loadReviewState().then(() => {
    setTimeout(checkShopeeReviews, 60_000); // chạy lần đầu sau 1 phút (chờ token load)
    setInterval(checkShopeeReviews, REVIEW_CHECK_INTERVAL_MS);
    console.log(`Shopee reviews scheduler started (check mỗi ${REVIEW_CHECK_INTERVAL_MS / 60000} phút)`);
  });

  // Shopee shop-outgoing chat monitoring (mỗi 15 phút)
  loadChatState().then(() => {
    setTimeout(checkShopOutgoingChats, 90_000); // chạy sau 1.5 phút (sau reviews)
    setInterval(checkShopOutgoingChats, CHAT_CHECK_INTERVAL_MS);
    console.log(`Shopee chat-monitor scheduler started (check mỗi ${CHAT_CHECK_INTERVAL_MS / 60000} phút)`);
  });

  // Mail watcher → Shopee alerts (group Shopee) + Callback request (group TT)
  startShopeeMailWatcher({
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
    onAlert: async ({ msg, type }) => {
      const targetGroup = type === 'callback' ? TT_GROUP_ID : SHOPEE_GROUP_ID;
      await api.sendMessage({
        msg,
        urgency: Urgency.Important,
        styles: [
          { start: 0, len: msg.length, st: TextStyle.Bold },
          { start: 0, len: msg.length, st: TextStyle.Big },
        ],
      }, targetGroup, ThreadType.Group);
    },
  });
});

async function checkPendingFbMessages() {
  const now = Date.now();
  let changed = false;

  for (const customerId of Object.keys(pendingFbMessages)) {
    const p = pendingFbMessages[customerId];
    const age = now - p.lastMessageAt;

    if (age >= FB_CLEANUP_AFTER_MS) {
      console.log(`Cleanup FB pending ${customerId} (quá 24h)`);
      delete pendingFbMessages[customerId];
      changed = true;
      continue;
    }

    if (age >= FB_WARN_AFTER_MS && !p.warned) {
      const warnMsg = `⚠️ Tin nhắn fanpage chưa được phản hồi (>30 phút)
👤 ${p.customerName}
💬 "${p.lastMessagePreview}"
🕐 Khách nhắn: ${new Date(p.lastMessageAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}

→ Mở Facebook Inbox để trả lời khách`;
      try {
        await api.sendMessage({
          msg: warnMsg,
          urgency: Urgency.Important,
          styles: [{ start: 0, len: warnMsg.length, st: TextStyle.Bold }],
        }, TT_GROUP_ID, ThreadType.Group);
        p.warned = true;
        changed = true;
        console.log(`Đã gửi cảnh báo FB cho khách ${customerId}`);
      } catch (err) {
        console.error(`Failed to send FB warning for ${customerId}:`, err);
      }
    }
  }

  if (changed) await savePendingFb();
}

async function checkPendingOrders() {
  const now = Date.now();
  let changed = false;

  for (const orderId of Object.keys(pendingOrders)) {
    const p = pendingOrders[orderId];
    const age = now - p.createdAt;

    if (age >= CLEANUP_AFTER_MS) {
      console.log(`Cleanup pending đơn web #${orderId} (quá 24h)`);
      delete pendingOrders[orderId];
      changed = true;
      continue;
    }

    if (age >= WARN_AFTER_MS && !p.warned) {
      const warnMsg = `⚠️ Đơn web #${p.orderId} đã quá 5h chưa có đơn GHTK
👤 ${p.customerName} — 📞 ${p.phone}
📅 Đặt lúc: ${new Date(p.createdAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}

→ Vui lòng kiểm tra và tạo đơn GHTK
(Bỏ qua tin này nếu khách đã hủy đơn)`;
      try {
        await api.sendMessage({
          msg: warnMsg,
          urgency: Urgency.Important,
          styles: [{ start: 0, len: warnMsg.length, st: TextStyle.Bold }],
        }, TT_GROUP_ID, ThreadType.Group);
        p.warned = true;
        changed = true;
        console.log(`Đã gửi cảnh báo cho đơn web #${orderId}`);
      } catch (err) {
        console.error(`Failed to send warning for order #${orderId}:`, err);
      }
    }
  }

  if (changed) await savePending();
}
