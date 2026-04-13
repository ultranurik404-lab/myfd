require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Client, Databases, ID } = require('node-appwrite');

// ── Telegram ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID);

// ── Appwrite ──────────────────────────────────────────────────────────────────
const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const db = new Databases(client);
const DB_ID = process.env.APPWRITE_DATABASE_ID;
const REVIEWS_COL = process.env.APPWRITE_REVIEWS_COLLECTION_ID;
const CASES_COL = process.env.APPWRITE_CASES_COLLECTION_ID;

// ── State machine ─────────────────────────────────────────────────────────────
const sessions = {};

function isAdmin(chatId) {
  return chatId === ADMIN_ID;
}

function sendMenu(chatId) {
  bot.sendMessage(chatId,
    `👋 *MonTech IT — Панель управления*\n\nВыбери действие:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['➕ Добавить отзыв', '➕ Добавить кейс'],
          ['📋 Список отзывов', '📋 Список кейсов'],
          ['🗑 Удалить отзыв', '🗑 Удалить кейс'],
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

// ── Message handler ───────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!isAdmin(chatId)) return;
  if (!text) return;

  const session = sessions[chatId];

  // ── Start flows ──
  if (text === '➕ Добавить отзыв') {
    sessions[chatId] = { flow: 'add_review', step: 'username' };
    return bot.sendMessage(chatId, '📝 *Имя / ник заказчика:*', { parse_mode: 'Markdown' });
  }

  if (text === '➕ Добавить кейс') {
    sessions[chatId] = { flow: 'add_case', step: 'title' };
    return bot.sendMessage(chatId, '📝 *Название кейса:*', { parse_mode: 'Markdown' });
  }

  // ── List ──
  if (text === '📋 Список отзывов') {
    try {
      const res = await db.listDocuments(DB_ID, REVIEWS_COL);
      if (!res.documents.length) return bot.sendMessage(chatId, 'Отзывов пока нет.');
      const list = res.documents.map((d, i) =>
        `${i + 1}. *@${d.username}* — ${d.project}\n   ID: \`${d.$id}\``
      ).join('\n\n');
      bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
    }
    return;
  }

  if (text === '📋 Список кейсов') {
    try {
      const res = await db.listDocuments(DB_ID, CASES_COL);
      if (!res.documents.length) return bot.sendMessage(chatId, 'Кейсов пока нет.');
      const list = res.documents.map((d, i) =>
        `${i + 1}. *${d.title}* — ${d.company || ''}\n   ID: \`${d.$id}\``
      ).join('\n\n');
      bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
    }
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

  // ── Handle delete flow ──
  if (session?.flow === 'delete_review' && session.step === 'id') {
    try {
      await db.deleteDocument(DB_ID, REVIEWS_COL, text.trim());
      bot.sendMessage(chatId, '✅ Отзыв удалён!');
    } catch (e) {
      bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
    }
    sessions[chatId] = null;
    return sendMenu(chatId);
  }

  if (session?.flow === 'delete_case' && session.step === 'id') {
    try {
      await db.deleteDocument(DB_ID, CASES_COL, text.trim());
      bot.sendMessage(chatId, '✅ Кейс удалён!');
    } catch (e) {
      bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
    }
    sessions[chatId] = null;
    return sendMenu(chatId);
  }

  // ── ADD REVIEW flow ──────────────────────────────────────────────────────────
  if (session?.flow === 'add_review') {
    if (session.step === 'username') {
      sessions[chatId].data = { username: text };
      sessions[chatId].step = 'project';
      return bot.sendMessage(chatId, '📁 *Тип проекта* (напр. "Чат-бот", "Лендинг", "Скрипт"):',
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
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );
    }
    if (session.step === 'rating') {
      const rating = parseInt(text);
      if (isNaN(rating) || rating < 1 || rating > 5) {
        return bot.sendMessage(chatId, '⚠️ Введи число от 1 до 5');
      }
      const data = sessions[chatId].data;

      // Preview
      const preview = `*Предпросмотр отзыва:*\n\n👤 @${data.username}\n📁 ${data.project}\n⭐ ${rating}/5\n💬 ${data.content}`;
      sessions[chatId].data.rating = rating;
      sessions[chatId].step = 'confirm';
      return bot.sendMessage(chatId, preview, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['✅ Сохранить', '❌ Отмена']],
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      });
    }
    if (session.step === 'confirm') {
      if (text === '✅ Сохранить') {
        try {
          const data = sessions[chatId].data;
          await db.createDocument(DB_ID, REVIEWS_COL, ID.unique(), {
            reviewerUsername: data.username,
            relatedProject: data.project,
            reviewContent: data.content,
            reviewRating: data.rating,
          });
          bot.sendMessage(chatId, '✅ Отзыв добавлен и появится на сайте!');
        } catch (e) {
          bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
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
      return bot.sendMessage(chatId, '🏢 *Название компании клиента:*', { parse_mode: 'Markdown' });
    }
    if (session.step === 'company') {
      sessions[chatId].data.company = text;
      sessions[chatId].step = 'category';
      return bot.sendMessage(chatId, '📂 *Категория* (Чат-бот / AI ассистент / Лендинг):',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['Чат-бот', 'AI ассистент', 'Лендинг']],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );
    }
    if (session.step === 'category') {
      sessions[chatId].data.category = text;
      sessions[chatId].step = 'description';
      return bot.sendMessage(chatId, '📝 *Описание кейса:*', { parse_mode: 'Markdown' });
    }
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
      sessions[chatId].step = 'imageUrl';
      return bot.sendMessage(chatId,
        '🖼 *Ссылка на изображение* (или отправь "-" чтобы пропустить):',
        { parse_mode: 'Markdown' });
    }
    if (session.step === 'imageUrl') {
      sessions[chatId].data.imageUrl = text === '-' ? '' : text;
      const data = sessions[chatId].data;

      // Preview
      const preview = `*Предпросмотр кейса:*\n\n📌 ${data.title}\n🏢 ${data.company}\n📂 ${data.category}\n📝 ${data.description}\n\n📊 ${data.result0}\n📊 ${data.result1}\n📊 ${data.result2}`;
      sessions[chatId].step = 'confirm';
      return bot.sendMessage(chatId, preview, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['✅ Сохранить', '❌ Отмена']],
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      });
    }
    if (session.step === 'confirm') {
      if (text === '✅ Сохранить') {
        try {
          const data = sessions[chatId].data;
          await db.createDocument(DB_ID, CASES_COL, ID.unique(), {
            caseTitle: data.title,
            category: data.category,
            caseDescription: data.description,
            outcome0: data.result0,
            outcome1: data.result1,
            outcome2: data.result2,
          });
          bot.sendMessage(chatId, '✅ Кейс добавлен и появится на сайте!');
        } catch (e) {
          bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
      } else {
        bot.sendMessage(chatId, '❌ Отменено.');
      }
      sessions[chatId] = null;
      return sendMenu(chatId);
    }
  }
});

console.log('🤖 MonTech Admin Bot запущен...');
