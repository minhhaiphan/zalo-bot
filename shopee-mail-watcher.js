import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'fs/promises';

const STATE_FILE = './shopee-mail-state.json';
const SHOPEE_SENDER_RE = /shopee\.vn|shopee\.com/i;
const SOLD_OUT_RE = /Sản phẩm của bạn\s+([\s\S]+?)\s+đã được bán hết/i;
const LOCKED_RE = /Sản phẩm\s+([\s\S]+?)\s+của bạn đã bị tạm khóa(?:\s+vì lý do:\s*,?\s*([^\n\r.]+))?/i;
const CALLBACK_SUBJECT_RE = /Callback request from\s+(\+?\d[\d\s.-]{7,})/i;
const CALLBACK_PHONE_RE = /Phone:\s*(\+?\d[\d\s.-]{7,})/i;
const CALLBACK_NAME_RE = /Name:\s*([^\n\r]+)/i;
const CALLBACK_EMAIL_RE = /Email:\s*([^\n\r]+)/i;
const CALLBACK_FROM_RE = /From:\s*(https?:\/\/[^\s\n\r]+)/i;

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { lastUid: 0 };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function classify(subject, text, from) {
  const s = subject || '';
  const b = text || '';
  const isShopee = SHOPEE_SENDER_RE.test(from || '');

  if (isShopee && (/đã được bán hết/i.test(s) || /đã được bán hết/i.test(b))) {
    const m = b.match(SOLD_OUT_RE) || s.match(SOLD_OUT_RE);
    const product = m?.[1]?.trim() || '(không xác định)';
    return { type: 'sold_out', product };
  }

  if (isShopee && (/bị tạm khóa|bị tạm khoá/i.test(s) || /bị tạm khóa|bị tạm khoá/i.test(b))) {
    const m = b.match(LOCKED_RE);
    const product = m?.[1]?.trim() || '(xem chi tiết trong email)';
    const reason = m?.[2]?.trim() || '';
    return { type: 'locked', product, reason };
  }

  if (CALLBACK_SUBJECT_RE.test(s)) {
    const phoneFromSubject = s.match(CALLBACK_SUBJECT_RE)?.[1]?.replace(/\s/g, '').trim();
    const phone = b.match(CALLBACK_PHONE_RE)?.[1]?.trim() || phoneFromSubject || '';
    const name = b.match(CALLBACK_NAME_RE)?.[1]?.trim() || '';
    const email = b.match(CALLBACK_EMAIL_RE)?.[1]?.trim() || '';
    const sourceUrl = b.match(CALLBACK_FROM_RE)?.[1]?.trim() || '';
    return { type: 'callback', phone, name, email, sourceUrl };
  }

  return null;
}

function buildMessage(info) {
  if (info.type === 'sold_out') {
    return `🛒 SẢN PHẨM SHOPEE ĐÃ BÁN HẾT\n📦 ${info.product}\n→ Cần kiểm tra & nhập kho/cập nhật tồn`;
  }
  if (info.type === 'locked') {
    let msg = `🔒 SẢN PHẨM SHOPEE BỊ TẠM KHOÁ\n📦 ${info.product}`;
    if (info.reason) msg += `\n⚠️ Lý do: ${info.reason}`;
    msg += `\n→ Vào Shopee Seller Center xử lý`;
    return msg;
  }
  if (info.type === 'callback') {
    let msg = `📞 KHÁCH YÊU CẦU GỌI LẠI (web)\n☎️ ${info.phone}`;
    if (info.name) msg += `\n👤 ${info.name}`;
    if (info.email) msg += `\n✉️ ${info.email}`;
    if (info.sourceUrl) msg += `\n🔗 ${info.sourceUrl}`;
    msg += `\n→ Gọi lại khách càng sớm càng tốt (9h00–20h30)`;
    return msg;
  }
  return null;
}

export function startShopeeMailWatcher({ user, pass, onAlert, log = console.log }) {
  if (!user || !pass) {
    log('[mail-watcher] thiếu GMAIL_USER hoặc GMAIL_APP_PASSWORD, skip');
    return;
  }

  let state = { lastUid: 0 };
  let client = null;
  let stopped = false;

  async function processMessage(uid, msg) {
    try {
      const parsed = await simpleParser(msg.source);
      const from = parsed.from?.value?.[0]?.address || '';

      const info = classify(parsed.subject, parsed.text || '', from);
      if (!info) return;

      const out = buildMessage(info);
      if (!out) return;

      log(`[mail-watcher] ${info.type}: ${info.product || info.phone || ''}`);
      await onAlert({ msg: out, type: info.type, info });
    } catch (err) {
      log(`[mail-watcher] processMessage error uid=${uid}:`, err.message);
    }
  }

  async function run() {
    state = await loadState();

    while (!stopped) {
      try {
        client = new ImapFlow({
          host: 'imap.gmail.com',
          port: 993,
          secure: true,
          auth: { user, pass },
          logger: false,
        });

        await client.connect();
        log('[mail-watcher] IMAP connected');
        await client.mailboxOpen('INBOX');

        if (state.lastUid === 0) {
          const status = await client.status('INBOX', { uidNext: true });
          state.lastUid = (status.uidNext || 1) - 1;
          await saveState(state);
          log(`[mail-watcher] khởi tạo lastUid=${state.lastUid} (chỉ xử lý mail mới từ giờ)`);
        }

        const scanNew = async () => {
          const range = `${state.lastUid + 1}:*`;
          let maxUid = state.lastUid;
          for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
            if (msg.uid <= state.lastUid) continue;
            await processMessage(msg.uid, msg);
            if (msg.uid > maxUid) maxUid = msg.uid;
          }
          if (maxUid > state.lastUid) {
            state.lastUid = maxUid;
            await saveState(state);
          }
        };

        await scanNew();

        client.on('exists', () => {
          scanNew().catch(err => log('[mail-watcher] scanNew error:', err.message));
        });

        while (!stopped && client.usable) {
          await client.idle();
        }
      } catch (err) {
        log('[mail-watcher] connection error:', err.message);
      } finally {
        try { await client?.logout(); } catch {}
      }

      if (!stopped) {
        log('[mail-watcher] reconnect sau 30s');
        await new Promise(r => setTimeout(r, 30_000));
      }
    }
  }

  run();

  return {
    stop: async () => {
      stopped = true;
      try { await client?.logout(); } catch {}
    },
  };
}
