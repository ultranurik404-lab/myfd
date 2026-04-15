require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Client, Databases, Storage, ID } = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');
const https = require('https');
const http = require('http');

// ── Telegram ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID);

// ── Appwrite ──────────────────────────────────────────────────────────────────
const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const db = new Databases(client);
const storage = new Storage(client);

const DB_ID       = process.env.APPWRITE_DATABASE_ID;
const REVIEWS_COL = process.env.APPWRITE_REVIEWS_COLLECTION_ID;
const CASES_COL   = process.env.APPWRITE_CASES_COLLECTION_ID;
const BUCKET_ID   = process.env.APPWRITE_BUCKET_ID;

// ── State ─────────────────────────────────────────────────────────────────────
const sessions = {};

function isAdmin(chatId) { return chatId === ADMIN_ID; }

// ── Upload helper ─────────────────────────────────────────────────────────────
async function uploadTelegramFileToAppwrite(fileId, filename) {
  const fileInfo = await bot.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    const mod = tgUrl.startsWith('https') ? https : http;
    mod.get(tgUrl, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

  const file = await storage.createFile(BUCKET_ID, ID.unique(), InputFile.fromBuffer(buffer, filename));
  const endpoint = process.env.APPWRITE_ENDPOINT.replace(/\/$/, '');
  return `${endpoint}/storage/buckets/${BUCKET_ID}/files/${file.$id}/view?project=${process.env.APPWRITE_PROJECT_ID}`;
}

// ── Sources & categories ──────────────────────────────────────────────────────
const SOURCE_MAP = {
  '🟢 Kwork': 'Kwork', '🟢 Upwork': 'Upwork',
  '📸 Instagram': 'Instagram', '🤝 Жизнь': 'Жизнь', '💬 Другое': 'Другое',
};
const CASE_CATEGORIES = ['Чат-бот', 'AI ассистент', 'Лендинг', 'Другое'];

// ── Menu ──────────────────────────────────────────────────────────────────────
function sendMenu(chatId) {
  bot.sendMessage(chatId, `👋 *MonTech IT — Панель управления*\n\nВыбери действие:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['➕ Добавить отзыв', '➕ Добавить кейс'],
        ['📋 Список отзывов', '📋 Список кейсов'],
        ['🗑 Удалить отзыв', '🗑 Удалить кейс'],
      ],
      resize_keyboard: true,
    },
  });
}

function ask(chatId, text, keyboard) {
  const opts = { parse_mode: 'Markdown' };
  if (keyboard) {
    opts.reply_markup = { keyboard, one_time_keyboard: true, resize_keyboard: true };
  } else {
    opts.reply_markup = { remove_keyboard: true };
  }
  return bot.sendMessage(chatId, text, opts);
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '⛔ Нет доступа.');
  sessions[msg.chat.id] = null;
  sendMenu(msg.chat.id);
});

// ── Main handler ──────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const text  = msg.text;
  const photo = msg.photo;
  const video = msg.video;

  // Always read fresh session
  const sess = sessions[chatId];

  // ══════════════════════════════════════════════════════════════════
  // CASE FLOW — media step (photo/video uploads)
  // ══════════════════════════════════════════════════════════════════
  if (sess?.flow === 'add_case' && sess.step === 'media' && (photo || video)) {
    const fileId   = photo ? photo[photo.length - 1].file_id : video.file_id;
    const ext      = photo ? 'jpg' : 'mp4';
    const mtype    = photo ? 'photo' : 'video';
    await bot.sendMessage(chatId, '⏳ Загружаю медиафайл...');
    try {
      const url = await uploadTelegramFileToAppwrite(fileId, `media_${Date.now()}.${ext}`);
      sessions[chatId].data.mediaUrls.push(url);
      sessions[chatId].data.mediaTypes.push(mtype);
      const n = sessions[chatId].data.mediaUrls.length;
      bot.sendMessage(chatId,
        `✅ Файл ${n} загружен!\nОтправь ещё или нажми *"✅ Готово"*.`,
        { parse_mode: 'Markdown', reply_markup: { keyboard: [['✅ Готово', '❌ Отмена']], resize_keyboard: true } }
      );
    } catch (e) { bot.sendMessage(chatId, `❌ Ошибка загрузки: ${e.message}`); }
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  // CASE FLOW — cover step (photo upload)
  // ══════════════════════════════════════════════════════════════════
  if (sess?.flow === 'add_case' && sess.step === 'cover') {
    if (photo) {
      const fileId = photo[photo.length - 1].file_id;
      await bot.sendMessage(chatId, '⏳ Загружаю обложку...');
      try {
        const url = await uploadTelegramFileToAppwrite(fileId, `cover_${Date.now()}.jpg`);
        sessions[chatId].data.coverUrl = url;
        sessions[chatId].step = 'description';
        return ask(chatId, '✅ Обложка загружена!\n\n📝 *Опиши кейс подробно — что сделали и для кого:*');
      } catch (e) {
        return bot.sendMessage(chatId, `❌ Ошибка загрузки: ${e.message}`);
      }
    }
    if (text === '-') {
      sessions[chatId].data.coverUrl = '';
      sessions[chatId].step = 'description';
      return ask(chatId, '📝 *Опиши кейс подробно — что сделали и для кого:*');
    }
    // Any other text while in cover step — remind user
    return bot.sendMessage(chatId, '📸 Отправь *фото* обложки или напиши *"-"* чтобы пропустить.', {
      parse_mode: 'Markdown', reply_markup: { remove_keyboard: true },
    });
  }

  // From here — only text messages
  if (!text) return;

  // ══════════════════════════════════════════════════════════════════
  // MENU ACTIONS
  // ══════════════════════════════════════════════════════════════════
  if (text === '➕ Добавить отзыв') {
    sessions[chatId] = { flow: 'add_review', step: 'username', data: {} };
    return ask(chatId, '📝 *Имя / ник заказчика:*');
  }
  if (text === '➕ Добавить кейс') {
    sessions[chatId] = { flow: 'add_case', step: 'title', data: { mediaUrls: [], mediaTypes: [] } };
    return ask(chatId, '📝 *Название кейса:*');
  }
  if (text === '📋 Список отзывов') {
    try {
      const res = await db.listDocuments(DB_ID, REVIEWS_COL);
      if (!res.documents.length) return bot.sendMessage(chatId, 'Отзывов пока нет.');
      const list = res.documents.map((d, i) =>
        `${i + 1}. *@${d.reviewerUsername}* [${d.source || 'Kwork'}] — ${d.relatedProject}\n   ID: \`${d.$id}\``
      ).join('\n\n');
      bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
    return;
  }
  if (text === '📋 Список кейсов') {
    try {
      const res = await db.listDocuments(DB_ID, CASES_COL);
      if (!res.documents.length) return bot.sendMessage(chatId, 'Кейсов пока нет.');
      const list = res.documents.map((d, i) =>
        `${i + 1}. *${d.caseTitle}* — ${d.category}\n   ID: \`${d.$id}\``
      ).join('\n\n');
      bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
    return;
  }
  if (text === '🗑 Удалить отзыв') {
    sessions[chatId] = { flow: 'delete_review', step: 'id' };
    return ask(chatId, '🆔 Введи ID отзыва (из списка):');
  }
  if (text === '🗑 Удалить кейс') {
    sessions[chatId] = { flow: 'delete_case', step: 'id' };
    return ask(chatId, '🆔 Введи ID кейса (из списка):');
  }

  // ══════════════════════════════════════════════════════════════════
  // DELETE FLOWS
  // ══════════════════════════════════════════════════════════════════
  if (sess?.flow === 'delete_review') {
    try { await db.deleteDocument(DB_ID, REVIEWS_COL, text.trim()); bot.sendMessage(chatId, '✅ Отзыв удалён!'); }
    catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
    sessions[chatId] = null; return sendMenu(chatId);
  }
  if (sess?.flow === 'delete_case') {
    try { await db.deleteDocument(DB_ID, CASES_COL, text.trim()); bot.sendMessage(chatId, '✅ Кейс удалён!'); }
    catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
    sessions[chatId] = null; return sendMenu(chatId);
  }

  // ══════════════════════════════════════════════════════════════════
  // ADD REVIEW FLOW
  // ══════════════════════════════════════════════════════════════════
  if (sess?.flow === 'add_review') {
    const s = sessions[chatId];
    switch (s.step) {
      case 'username':
        s.data.username = text;
        s.step = 'source';
        return ask(chatId, '🌐 *Откуда отзыв?*', [
          ['🟢 Kwork', '🟢 Upwork'],
          ['📸 Instagram', '🤝 Жизнь', '💬 Другое'],
        ]);
      case 'source':
        s.data.source = SOURCE_MAP[text] || text;
        s.step = 'project';
        return ask(chatId, '📁 *Тип проекта* (напр. "Чат-бот", "Лендинг"):');
      case 'project':
        s.data.project = text;
        s.step = 'content';
        return ask(chatId, '💬 *Текст отзыва:*');
      case 'content':
        s.data.content = text;
        s.step = 'rating';
        return ask(chatId, '⭐ *Оценка* (1-5):', [['5', '4', '3']]);
      case 'rating': {
        const rating = parseInt(text);
        if (isNaN(rating) || rating < 1 || rating > 5)
          return bot.sendMessage(chatId, '⚠️ Введи число от 1 до 5');
        s.data.rating = rating;
        s.step = 'confirm';
        const p = s.data;
        return ask(chatId,
          `*Предпросмотр:*\n\n👤 @${p.username}\n🌐 ${p.source}\n📁 ${p.project}\n⭐ ${rating}/5\n💬 ${p.content}`,
          [['✅ Сохранить', '❌ Отмена']]
        );
      }
      case 'confirm':
        if (text === '✅ Сохранить') {
          try {
            const d = s.data;
            await db.createDocument(DB_ID, REVIEWS_COL, ID.unique(), {
              reviewerUsername: d.username,
              relatedProject:  d.project,
              reviewContent:   d.content,
              reviewRating:    d.rating,
              source:          d.source,
            });
            bot.sendMessage(chatId, '✅ Отзыв добавлен!');
          } catch (e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
        } else { bot.sendMessage(chatId, '❌ Отменено.'); }
        sessions[chatId] = null;
        return sendMenu(chatId);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ADD CASE FLOW
  // ══════════════════════════════════════════════════════════════════
  if (sess?.flow === 'add_case') {
    const s = sessions[chatId];
    switch (s.step) {
      case 'title':
        if (!text.trim()) return bot.sendMessage(chatId, '⚠️ Название не может быть пустым. Введи название кейса:');
        s.data.title = text.trim();
        s.step = 'company';
        return ask(chatId, '🏢 *Название компании/клиента:*');

      case 'company':
        s.data.company = text.trim();
        s.step = 'category';
        return ask(chatId, '📂 *Категория:*', [
          ['Чат-бот', 'AI ассистент'],
          ['Лендинг', 'Другое'],
        ]);

      case 'category':
        if (!CASE_CATEGORIES.includes(text))
          return ask(chatId, '⚠️ Выбери категорию кнопкой:', [['Чат-бот', 'AI ассистент'], ['Лендинг', 'Другое']]);
        s.data.category = text;
        s.step = 'cover';
        return bot.sendMessage(chatId,
          '🖼 *Обложка кейса*\n\nОтправь фото обложки или напиши *"-"* чтобы пропустить:',
          { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );

      case 'cover':
        // text в cover шаге (не "-") — напоминаем
        if (text !== '-') return bot.sendMessage(chatId, '📸 Отправь *фото* или напиши *"-"* чтобы пропустить.', { parse_mode: 'Markdown' });
        s.data.coverUrl = '';
        s.step = 'description';
        return ask(chatId, '📝 *Опиши кейс подробно — что сделали и для кого:*');

      case 'description':
        if (!text.trim()) return bot.sendMessage(chatId, '⚠️ Описание не может быть пустым. Напишите описание кейса:');
        s.data.description = text.trim();
        s.step = 'result0';
        return ask(chatId, '📊 *Результат 1* (напр. "+300% к продажам"):');

      case 'result0':
        s.data.result0 = text.trim();
        s.step = 'result1';
        return ask(chatId, '📊 *Результат 2:*');

      case 'result1':
        s.data.result1 = text.trim();
        s.step = 'result2';
        return ask(chatId, '📊 *Результат 3:*');

      case 'result2':
        s.data.result2 = text.trim();
        s.step = 'media';
        return bot.sendMessage(chatId,
          `📎 *Медиафайлы кейса*\n\nОтправь фото/видео для галереи (можно несколько).\nКогда закончишь — нажми *"✅ Готово"*.`,
          {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [['✅ Готово', '❌ Отмена']], resize_keyboard: true },
          }
        );

      case 'media':
        if (text === '❌ Отмена') { bot.sendMessage(chatId, '❌ Отменено.'); sessions[chatId] = null; return sendMenu(chatId); }
        if (text === '✅ Готово') {
          const d = s.data;
          s.step = 'confirm';
          const descPreview = d.description.length > 100 ? d.description.slice(0, 100) + '...' : d.description;
          return ask(chatId,
            `*Предпросмотр кейса:*\n\n📌 ${d.title}\n🏢 ${d.company}\n📂 ${d.category}\n📝 ${descPreview}\n\n📊 ${d.result0}\n📊 ${d.result1}\n📊 ${d.result2}\n\n🖼 Обложка: ${d.coverUrl ? '✅' : '—'}\n📎 Медиафайлов: ${d.mediaUrls.length}`,
            [['✅ Сохранить', '❌ Отмена']]
          );
        }
        return bot.sendMessage(chatId, 'Отправь фото/видео или нажми *"✅ Готово"*.', { parse_mode: 'Markdown' });

      case 'confirm':
        if (text === '✅ Сохранить') {
          try {
            const d = s.data;
            await db.createDocument(DB_ID, CASES_COL, ID.unique(), {
              caseTitle:       d.title,
              company:         d.company,
              category:        d.category,
              caseDescription: d.description,
              outcome0:        d.result0,
              outcome1:        d.result1,
              outcome2:        d.result2,
              coverUrl:        d.coverUrl || '',
              mediaUrls:       JSON.stringify(d.mediaUrls || []),
              mediaTypes:      JSON.stringify(d.mediaTypes || []),
            });
            bot.sendMessage(chatId, `✅ Кейс сохранён!\n📎 Медиафайлов: ${(d.mediaUrls || []).length}`);
          } catch (e) { bot.sendMessage(chatId, `❌ Ошибка Appwrite: ${e.message}`); }
        } else { bot.sendMessage(chatId, '❌ Отменено.'); }
        sessions[chatId] = null;
        return sendMenu(chatId);
    }
  }
});

console.log('🤖 MonTech Admin Bot запущен...');
