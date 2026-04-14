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

const DB_ID      = process.env.APPWRITE_DATABASE_ID;
const REVIEWS_COL = process.env.APPWRITE_REVIEWS_COLLECTION_ID;
const CASES_COL   = process.env.APPWRITE_CASES_COLLECTION_ID;
const BUCKET_ID   = process.env.APPWRITE_BUCKET_ID; // Storage bucket for media

// ── Helpers ───────────────────────────────────────────────────────────────────
function isAdmin(chatId) { return chatId === ADMIN_ID; }

/**
 * Download a Telegram file by file_id and upload to Appwrite Storage.
 * Returns the public URL of the uploaded file.
 */
async function uploadTelegramFileToAppwrite(fileId, filename) {
  const fileInfo = await bot.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;

  // Download file into a Buffer
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    const protocol = tgUrl.startsWith('https') ? https : http;
    protocol.get(tgUrl, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

  // Upload to Appwrite Storage
  const file = await storage.createFile(
    BUCKET_ID,
    ID.unique(),
    InputFile.fromBuffer(buffer, filename)
  );

  // Return public URL
  const endpoint = process.env.APPWRITE_ENDPOINT.replace(/\/$/, '');
  const projectId = process.env.APPWRITE_PROJECT_ID;
  return `${endpoint}/storage/buckets/${BUCKET_ID}/files/${file.$id}/view?project=${projectId}`;
}

// ── State machine ─────────────────────────────────────────────────────────────
const sessions = {};

// ── Sources config ────────────────────────────────────────────────────────────
const REVIEW_SOURCES = {
  'Kwork':     { emoji: '🟢', label: 'Kwork' },
  'Upwork':    { emoji: '🟢', label: 'Upwork' },
  'Instagram': { emoji: '📸', label: 'Instagram' },
  'Жизнь':     { emoji: '🤝', label: 'Жизнь' },
  'Другое':    { emoji: '💬', label: 'Другое' },
};

const CASE_CATEGORIES = ['Чат-бот', 'AI ассистент', 'Лендинг', 'Другое'];

// ── Menu ──────────────────────────────────────────────────────────────────────
function sendMenu(chatId) {
  bot.sendMessage(chatId,
    `👋 *MonTech IT — Панель управления*\n\nВыбери действие:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['➕ Добавить отзыв', '➕ Добавить кейс'],
          ['📋 Список отзывов', '📋 Список кейсов'],
          ['🗑 Удалить отзыв',  '🗑 Удалить кейс'],
        ],
        resize_keyboard: true,
      },
    }
  );
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '⛔ Нет доступа.');
  sessions[msg.chat.id] = null;
  sendMenu(msg.chat.id);
});

// ── Message & Photo/Video handler ─────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const text    = msg.text;
  const photo   = msg.photo;
  const video   = msg.video;
  const session = sessions[chatId];

  // ── Handle media upload during case media step ──
  if (session?.flow === 'add_case' && session.step === 'media') {
    if (photo || video) {
      const fileId   = photo ? photo[photo.length - 1].file_id : video.file_id;
      const ext      = photo ? 'jpg' : 'mp4';
      const filename = `case_media_${Date.now()}.${ext}`;
      const mediaType = photo ? 'photo' : 'video';

      try {
        bot.sendMessage(chatId, '⏳ Загружаю медиафайл...');
        const url = await uploadTelegramFileToAppwrite(fileId, filename);
        sessions[chatId].data.mediaUrls = sessions[chatId].data.mediaUrls || [];
        sessions[chatId].data.mediaTypes = sessions[chatId].data.mediaTypes || [];
        sessions[chatId].data.mediaUrls.push(url);
        sessions[chatId].data.mediaTypes.push(mediaType);
        bot.sendMessage(chatId,
          `✅ Файл ${sessions[chatId].data.mediaUrls.length} загружен!\n\nОтправь ещё фото/видео или нажми *"✅ Готово"* для сохранения.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              keyboard: [['✅ Готово', '❌ Отмена']],
              one_time_keyboard: false,
              resize_keyboard: true,
            },
          }
        );
      } catch (e) {
        bot.sendMessage(chatId, `❌ Ошибка загрузки: ${e.message}`);
      }
      return;
    }
  }

  // ── Handle cover photo upload during case cover step ──
  if (session?.flow === 'add_case' && session.step === 'cover') {
    if (photo) {
      const fileId   = photo[photo.length - 1].file_id;
      const filename = `case_cover_${Date.now()}.jpg`;
      try {
        bot.sendMessage(chatId, '⏳ Загружаю обложку...');
        const url = await uploadTelegramFileToAppwrite(fileId, filename);
        sessions[chatId].data.coverUrl = url;
        sessions[chatId].step = 'description';
        return bot.sendMessage(chatId, '✅ Обложка загружена!\n\n📝 *Описание кейса:*', { parse_mode: 'Markdown' });
      } catch (e) {
        return bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
      }
    }
    // Allow "-" to skip cover
    if (text === '-') {
      sessions[chatId].data.coverUrl = '';
      sessions[chatId].step = 'description';
      return bot.sendMessage(chatId, '📝 *Описание кейса:*', { parse_mode: 'Markdown' });
    }
  }

  if (!text) return;

  // ── Start flows ──
  if (text === '➕ Добавить отзыв') {
    sessions[chatId] = { flow: 'add_review', step: 'username' };
    return bot.sendMessage(chatId, '📝 *Имя / ник заказчика:*', { parse_mode: 'Markdown' });
  }

  if (text === '➕ Добавить кейс') {
    sessions[chatId] = { flow: 'add_case', step: 'title', data: {} };
    return bot.sendMessage(chatId, '📝 *Название кейса:*', { parse_mode: 'Markdown' });
  }

  // ── List ──
  if (text === '📋 Список отзывов') {
    try {
      const res = await db.listDocuments(DB_ID, REVIEWS_COL);
      if (!res.documents.length) return bot.sendMessage(chatId, 'Отзывов пока нет.');
      const list = res.documents.map((d, i) =>
        `${i + 1}. *@${d.reviewerUsername}* [${d.source || 'Kwork'}] — ${d.relatedProject}\n   ID: \`${d.$id}\``
      ).join('\n\n');
      bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
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
    } catch (e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
    return;
  }

  // ── Delete ──
  if (text === '🗑 Удалить отзыв') {
    sessions[chatId] = { flow: 'delete_review', step: 'id' };
    return bot.sendMessage(chatId, '🆔 Введи ID отзыва (из списка):');
  }
  if (text === '🗑 Удалить кейс') {
    sessions[chatId] = { flow: 'delete_case', step: 'id' };
    return bot.sendMessage(chatId, '🆔 Введи ID кейса (из списка):');
  }

  if (session?.flow === 'delete_review' && session.step === 'id') {
    try {
      await db.deleteDocument(DB_ID, REVIEWS_COL, text.trim());
      bot.sendMessage(chatId, '✅ Отзыв удалён!');
    } catch (e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
    sessions[chatId] = null;
    return sendMenu(chatId);
  }

  if (session?.flow === 'delete_case' && session.step === 'id') {
    try {
      await db.deleteDocument(DB_ID, CASES_COL, text.trim());
      bot.sendMessage(chatId, '✅ Кейс удалён!');
    } catch (e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
    sessions[chatId] = null;
    return sendMenu(chatId);
  }

  // ── ADD REVIEW flow ──────────────────────────────────────────────────────────
  if (session?.flow === 'add_review') {
    if (session.step === 'username') {
      sessions[chatId].data = { username: text };
      sessions[chatId].step = 'source';
      return bot.sendMessage(chatId,
        '🌐 *Откуда отзыв?* Выбери платформу:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [
              ['🟢 Kwork', '🟢 Upwork'],
              ['📸 Instagram', '🤝 Жизнь', '💬 Другое'],
            ],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );
    }
    if (session.step === 'source') {
      // Strip emoji prefix if user clicked button
      const sourceMap = {
        '🟢 Kwork': 'Kwork', '🟢 Upwork': 'Upwork',
        '📸 Instagram': 'Instagram', '🤝 Жизнь': 'Жизнь', '💬 Другое': 'Другое',
      };
      sessions[chatId].data.source = sourceMap[text] || text;
      sessions[chatId].step = 'project';
      return bot.sendMessage(chatId, '📁 *Тип проекта* (напр. "Чат-бот", "Лендинг"):',
        { parse_mode: 'Markdown' });
    }
    if (session.step === 'project') {
      sessions[chatId].data.project = text;
      sessions[chatId].step = 'content';
      return bot.sendMessage(chatId, '💬 *Текст отзыва:*', { parse_mode: 'Markdown' });
    }
    if (session.step === 'content') {
      sessions[chatId].data.content = text;
      sessions[chatId].step = 'rating';
      return bot.sendMessage(chatId, '⭐ *Оценка* (1-5):',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['5', '4', '3']],
            one_time_keyboard: true, resize_keyboard: true,
          },
        }
      );
    }
    if (session.step === 'rating') {
      const rating = parseInt(text);
      if (isNaN(rating) || rating < 1 || rating > 5)
        return bot.sendMessage(chatId, '⚠️ Введи число от 1 до 5');
      const data = sessions[chatId].data;
      sessions[chatId].data.rating = rating;
      sessions[chatId].step = 'confirm';
      const preview = `*Предпросмотр отзыва:*\n\n👤 @${data.username}\n🌐 ${data.source}\n📁 ${data.project}\n⭐ ${rating}/5\n💬 ${data.content}`;
      return bot.sendMessage(chatId, preview, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['✅ Сохранить', '❌ Отмена']],
          one_time_keyboard: true, resize_keyboard: true,
        },
      });
    }
    if (session.step === 'confirm') {
      if (text === '✅ Сохранить') {
        try {
          const data = sessions[chatId].data;
          await db.createDocument(DB_ID, REVIEWS_COL, ID.unique(), {
            reviewerUsername: data.username,
            relatedProject:  data.project,
            reviewContent:   data.content,
            reviewRating:    data.rating,
            source:          data.source,
          });
          bot.sendMessage(chatId, '✅ Отзыв добавлен и появится на сайте!');
        } catch (e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
      } else {
        bot.sendMessage(chatId, '❌ Отменено.');
      }
      sessions[chatId] = null;
      return sendMenu(chatId);
    }
  }

  // ── ADD CASE flow ─────────────────────────────────────────────────────────────
  if (session?.flow === 'add_case') {
    if (session.step === 'title') {
      sessions[chatId].data = { title: text };
      sessions[chatId].step = 'company';
      return bot.sendMessage(chatId, '🏢 *Название компании/клиента:*', { parse_mode: 'Markdown' });
    }
    if (session.step === 'company') {
      sessions[chatId].data.company = text;
      sessions[chatId].step = 'category';
      return bot.sendMessage(chatId, '📂 *Категория:*',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [CASE_CATEGORIES.slice(0, 2), CASE_CATEGORIES.slice(2)],
            one_time_keyboard: true, resize_keyboard: true,
          },
        }
      );
    }
    if (session.step === 'category') {
      sessions[chatId].data.category = text;
      sessions[chatId].step = 'cover';
      return bot.sendMessage(chatId,
        '🖼 *Обложка кейса*\n\nОтправь фото обложки или напиши "-" чтобы пропустить:',
        { parse_mode: 'Markdown' }
      );
    }
    // 'cover' step handled above (photo handler)
    if (session.step === 'description') {
      sessions[chatId].data.description = text;
      sessions[chatId].step = 'result0';
      return bot.sendMessage(chatId, '📊 *Результат 1* (напр. "+300% к продажам"):',
        { parse_mode: 'Markdown' });
    }
    if (session.step === 'result0') {
      sessions[chatId].data.result0 = text;
      sessions[chatId].step = 'result1';
      return bot.sendMessage(chatId, '📊 *Результат 2:*', { parse_mode: 'Markdown' });
    }
    if (session.step === 'result1') {
      sessions[chatId].data.result1 = text;
      sessions[chatId].step = 'result2';
      return bot.sendMessage(chatId, '📊 *Результат 3:*', { parse_mode: 'Markdown' });
    }
    if (session.step === 'result2') {
      sessions[chatId].data.result2 = text;
      sessions[chatId].step = 'media';
      sessions[chatId].data.mediaUrls  = [];
      sessions[chatId].data.mediaTypes = [];
      return bot.sendMessage(chatId,
        `📎 *Медиафайлы кейса*\n\nОтправь фото и/или видео для галереи кейса.\nМожно отправить несколько штук по одному.\nКогда закончишь — нажми *"✅ Готово"*.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['✅ Готово', '❌ Отмена']],
            one_time_keyboard: false, resize_keyboard: true,
          },
        }
      );
    }
    if (session.step === 'media') {
      if (text === '✅ Готово') {
        const data = sessions[chatId].data;
        const preview = `*Предпросмотр кейса:*\n\n📌 ${data.title}\n🏢 ${data.company}\n📂 ${data.category}\n📝 ${data.description}\n\n📊 ${data.result0}\n📊 ${data.result1}\n📊 ${data.result2}\n\n🖼 Обложка: ${data.coverUrl ? '✅' : '—'}\n📎 Медиафайлов: ${data.mediaUrls.length}`;
        sessions[chatId].step = 'confirm';
        return bot.sendMessage(chatId, preview, {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['✅ Сохранить', '❌ Отмена']],
            one_time_keyboard: true, resize_keyboard: true,
          },
        });
      }
      if (text === '❌ Отмена') {
        bot.sendMessage(chatId, '❌ Отменено.');
        sessions[chatId] = null;
        return sendMenu(chatId);
      }
    }
    if (session.step === 'confirm') {
      if (text === '✅ Сохранить') {
        try {
          const data = sessions[chatId].data;
          await db.createDocument(DB_ID, CASES_COL, ID.unique(), {
            caseTitle:    data.title,
            company:      data.company,
            category:     data.category,
            caseDescription: data.description,
            outcome0:     data.result0,
            outcome1:     data.result1,
            outcome2:     data.result2,
            coverUrl:     data.coverUrl || '',
            mediaUrls:    JSON.stringify(data.mediaUrls || []),
            mediaTypes:   JSON.stringify(data.mediaTypes || []),
          });
          bot.sendMessage(chatId, `✅ Кейс добавлен!\n📎 Медиафайлов: ${(data.mediaUrls || []).length}`);
        } catch (e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
      } else {
        bot.sendMessage(chatId, '❌ Отменено.');
      }
      sessions[chatId] = null;
      return sendMenu(chatId);
    }
  }
});

console.log('🤖 MonTech Admin Bot запущен...');
