require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const bot = new Telegraf(process.env.ADMIN_BOT_TOKEN);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.DATABASE_SSL === "true"
            ? { rejectUnauthorized: false }
            : false
});

const VAULT_CHAT_ID = process.env.FILE_VAULT_CHAT_ID;

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

const sessions = new Map();

const DEPARTMENTS = [
    { id: "mechanical", name: "ميكانيكا" },
    { id: "civil", name: "مدنية" },
    { id: "electrical", name: "كهرباء" }
];

const CONTENT_TYPES = [
    "محاضرات",
    "ملخصات",
    "كتب",
    "امتحانات سابقة",
    "حلول امتحانات",
    "مراجع أخرى"
];

function isAdmin(ctx) {
    return ADMIN_IDS.includes(String(ctx.from.id));
}

function mainKeyboard() {
    return Markup.keyboard([
        ["📤 رفع ملف جديد"],
        ["📚 عرض إحصائيات المكتبة"],
        ["❌ إلغاء العملية"]
    ]).resize();
}

function departmentKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("⚙️ ميكانيكا", "dep:mechanical"),
            Markup.button.callback("🏗️ مدنية", "dep:civil")
        ],
        [
            Markup.button.callback("⚡ كهرباء", "dep:electrical")
        ]
    ]);
}

function numberKeyboard(items, prefix) {
    const buttons = items.map((item, index) =>
        Markup.button.callback(
            item.name || item,
            `${prefix}:${item.id !== undefined ? item.id : index}`
        )
    );

    const rows = [];

    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }

    return Markup.inlineKeyboard(rows);
}

async function query(sql, params = []) {
    const result = await pool.query(sql, params);
    return result;
}

async function getDepartments() {
    return query(
        "SELECT id, name FROM departments ORDER BY name"
    );
}

async function getLevels(departmentId) {
    return query(
        `SELECT id, level_number, name
         FROM academic_levels
         WHERE department_id = $1
         ORDER BY level_number`,
        [departmentId]
    );
}

async function getSemesters(levelId) {
    return query(
        `SELECT id, semester_number, name
         FROM semesters
         WHERE level_id = $1
         ORDER BY semester_number`,
        [levelId]
    );
}

async function getSubjects(departmentId, levelId, semesterId) {
    return query(
        `SELECT id, name
         FROM subjects
         WHERE department_id = $1
           AND level_id = $2
           AND semester_id = $3
         ORDER BY name`,
        [departmentId, levelId, semesterId]
    );
}

bot.use(async (ctx, next) => {
    if (!ctx.from) return;

    if (!isAdmin(ctx)) {
        if (ctx.message || ctx.callbackQuery) {
            try {
                await ctx.reply(
                    "⛔ هذا البوت مخصص للمشرفين المعتمدين فقط."
                );
            } catch (_) {}
        }
        return;
    }

    return next();
});

bot.start(async ctx => {
    sessions.delete(ctx.from.id);

    await ctx.reply(
        "مرحبًا بك في لوحة إدارة مكتبة كلية الهندسة بجامعة كسلا.\n\n" +
        "يمكنك رفع ملفات PDF وتصنيفها وإضافتها إلى المكتبة.",
        mainKeyboard()
    );
});

bot.hears("❌ إلغاء العملية", async ctx => {
    sessions.delete(ctx.from.id);

    await ctx.reply(
        "تم إلغاء العملية.",
        mainKeyboard()
    );
});

bot.hears("📤 رفع ملف جديد", async ctx => {
    sessions.set(ctx.from.id, {
        step: "title"
    });

    await ctx.reply(
        "📤 رفع ملف جديد\n\n" +
        "أرسل عنوان الملف الذي تريد إضافته.\n\n" +
        "مثال: محاضرات الديناميكا الحرارية - الجزء الأول"
    );
});

bot.hears("📚 عرض إحصائيات المكتبة", async ctx => {
    try {
        const result = await query(
            `SELECT
                COUNT(*) AS total,
                COUNT(DISTINCT subject_id) AS subjects
             FROM library_files`
        );

        const row = result.rows[0];

        await ctx.reply(
            "📊 إحصائيات المكتبة\n\n" +
            `📄 إجمالي الملفات: ${row.total}\n` +
            `📚 المقررات التي تحتوي على ملفات: ${row.subjects}`,
            mainKeyboard()
        );
    } catch (error) {
        console.error("Statistics error:", error.message);

        await ctx.reply(
            "تعذر جلب الإحصائيات. تأكد من إعداد قاعدة البيانات."
        );
    }
});

bot.action(/^dep:(.+)$/, async ctx => {
    await ctx.answerCbQuery();

    const departmentKey = ctx.match[1];

    const department = DEPARTMENTS.find(
        item => item.id === departmentKey
    );

    if (!department) {
        return ctx.reply("التخصص المحدد غير معروف.");
    }

    const session = sessions.get(ctx.from.id);

    if (!session) {
        return ctx.reply("ابدأ العملية مجددًا باستخدام زر رفع ملف جديد.");
    }

    try {
        const result = await getDepartments();

        const row = result.rows.find(
            item => String(item.name).includes(department.name)
        );

        if (!row) {
            return ctx.reply(
                "لم أجد هذا التخصص في قاعدة البيانات.\n" +
                "تأكد من أسماء التخصصات الموجودة في جدول departments."
            );
        }

        session.departmentId = row.id;
        session.departmentName = row.name;
        session.step = "level";

        const levels = await getLevels(row.id);

        if (levels.rows.length === 0) {
            return ctx.reply(
                "لا توجد مستويات مسجلة لهذا التخصص في قاعدة البيانات."
            );
        }

        const buttons = levels.rows.map(level => [
            Markup.button.callback(
                level.name || `المستوى ${level.level_number}`,
                `level:${level.id}`
            )
        ]);

        await ctx.reply(
            "اختر المستوى الدراسي:",
            Markup.inlineKeyboard(buttons)
        );
    } catch (error) {
        console.error(error);

        await ctx.reply(
            "حدث خطأ أثناء تحميل المستويات. راجع إعداد قاعدة البيانات."
        );
    }
});

bot.action(/^level:(.+)$/, async ctx => {
    await ctx.answerCbQuery();

    const session = sessions.get(ctx.from.id);

    if (!session) {
        return ctx.reply("ابدأ العملية مجددًا.");
    }

    try {
        const result = await getLevels(session.departmentId);

        const level = result.rows.find(
            item => String(item.id) === String(ctx.match[1])
        );

        if (!level) {
            return ctx.reply("المستوى غير موجود.");
        }

        session.levelId = level.id;
        session.levelName =
            level.name || `المستوى ${level.level_number}`;

        const semesters = await getSemesters(level.id);

        if (semesters.rows.length === 0) {
            return ctx.reply("لا توجد فصول دراسية مسجلة لهذا المستوى.");
        }

        const buttons = semesters.rows.map(semester => [
            Markup.button.callback(
                semester.name || `الفصل ${semester.semester_number}`,
                `semester:${semester.id}`
            )
        ]);

        await ctx.reply(
            "اختر الفصل الدراسي:",
            Markup.inlineKeyboard(buttons)
        );
    } catch (error) {
        console.error(error);
        await ctx.reply("تعذر تحميل الفصول الدراسية.");
    }
});

bot.action(/^semester:(.+)$/, async ctx => {
    await ctx.answerCbQuery();

    const session = sessions.get(ctx.from.id);

    if (!session) {
        return ctx.reply("ابدأ العملية مجددًا.");
    }

    try {
        const result = await getSemesters(session.levelId);

        const semester = result.rows.find(
            item => String(item.id) === String(ctx.match[1])
        );

        if (!semester) {
            return ctx.reply("الفصل الدراسي غير موجود.");
        }

        session.semesterId = semester.id;
        session.semesterName =
            semester.name || `الفصل ${semester.semester_number}`;

        const subjects = await getSubjects(
            session.departmentId,
            session.levelId,
            session.semesterId
        );

        if (subjects.rows.length === 0) {
            return ctx.reply(
                "لا توجد مقررات مسجلة لهذا الفصل.\n" +
                "أضف المقررات أولًا إلى قاعدة البيانات."
            );
        }

        const buttons = subjects.rows.map(subject => [
            Markup.button.callback(
                subject.name,
                `subject:${subject.id}`
            )
        ]);

        await ctx.reply(
            "اختر المقرر:",
            Markup.inlineKeyboard(buttons)
        );
    } catch (error) {
        console.error(error);
        await ctx.reply("تعذر تحميل المقررات.");
    }
});

bot.action(/^subject:(.+)$/, async ctx => {
    await ctx.answerCbQuery();

    const session = sessions.get(ctx.from.id);

    if (!session) {
        return ctx.reply("ابدأ العملية مجددًا.");
    }

    try {
        const result = await getSubjects(
            session.departmentId,
            session.levelId,
            session.semesterId
        );

        const subject = result.rows.find(
            item => String(item.id) === String(ctx.match[1])
        );

        if (!subject) {
            return ctx.reply("المقرر غير موجود.");
        }

        session.subjectId = subject.id;
        session.subjectName = subject.name;
        session.step = "content_type";

        const buttons = CONTENT_TYPES.map((type, index) => [
            Markup.button.callback(type, `type:${index}`)
        ]);

        await ctx.reply(
            "اختر نوع المحتوى:",
            Markup.inlineKeyboard(buttons)
        );
    } catch (error) {
        console.error(error);
        await ctx.reply("تعذر تحديد المقرر.");
    }
});

bot.action(/^type:(\d+)$/, async ctx => {
    await ctx.answerCbQuery();

    const session = sessions.get(ctx.from.id);

    if (!session) {
        return ctx.reply("ابدأ العملية مجددًا.");
    }

    const index = Number(ctx.match[1]);

    if (!CONTENT_TYPES[index]) {
        return ctx.reply("نوع المحتوى غير صحيح.");
    }

    session.contentType = CONTENT_TYPES[index];
    session.step = "file";

    await ctx.reply(
        "📎 أرسل ملف PDF الآن.\n\n" +
        "سيتم حفظ الملف في قناة الأرشيف، ثم تسجيل بياناته في المكتبة."
    );
});

bot.on("document", async ctx => {
    const session = sessions.get(ctx.from.id);

    if (!session || session.step !== "file") {
        return ctx.reply(
            "لبدء رفع ملف، اضغط «📤 رفع ملف جديد».",
            mainKeyboard()
        );
    }

    const document = ctx.message.document;

    if (
        document.mime_type !== "application/pdf" &&
        !document.file_name?.toLowerCase().endsWith(".pdf")
    ) {
        return ctx.reply(
            "❌ الملف ليس PDF.\nأرسل ملف PDF فقط."
        );
    }

    if (!VAULT_CHAT_ID) {
        return ctx.reply(
            "❌ متغير FILE_VAULT_CHAT_ID غير مضبوط في إعدادات الخدمة."
        );
    }

    const status = await ctx.reply(
        "⏳ جارٍ حفظ الملف في قناة الأرشيف..."
    );

    let vaultMessage;

    try {
        // نسخ ملف Telegram إلى قناة الأرشيف الخاصة.
        vaultMessage = await ctx.telegram.copyMessage(
            VAULT_CHAT_ID,
            ctx.chat.id,
            ctx.message.message_id
        );

        const insert = await query(
            `INSERT INTO library_files
                (
                    department_id,
                    level_id,
                    semester_id,
                    subject_id,
                    title,
                    content_type,
                    file_name,
                    vault_chat_id,
                    vault_message_id,
                    uploaded_by
                )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id`,
            [
                session.departmentId,
                session.levelId,
                session.semesterId,
                session.subjectId,
                session.title,
                session.contentType,
                document.file_name || "document.pdf",
                String(VAULT_CHAT_ID),
                vaultMessage.message_id,
                String(ctx.from.id)
            ]
        );

        sessions.delete(ctx.from.id);

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            status.message_id,
            undefined,
            "✅ تمت إضافة الملف بنجاح!\n\n" +
            `🆔 رقم الملف: ${insert.rows[0].id}\n` +
            `📄 العنوان: ${session.title}\n` +
            `🏛️ التخصص: ${session.departmentName}\n` +
            `🎓 المستوى: ${session.levelName}\n` +
            `📅 الفصل: ${session.semesterName}\n` +
            `📚 المقرر: ${session.subjectName}\n` +
            `📂 النوع: ${session.contentType}`
        );

        await ctx.reply(
            "يمكنك الآن رفع ملف آخر أو عرض الإحصائيات.",
            mainKeyboard()
        );
    } catch (error) {
        console.error("Upload error:", error);

        await ctx.reply(
            "❌ تعذر إكمال عملية الحفظ.\n\n" +
            "تحقق من اتصال قاعدة البيانات وصلاحيات البوت في قناة الأرشيف.\n" +
            "قد يكون الملف قد نُسخ إلى القناة قبل وقوع الخطأ؛ افحص الأرشيف قبل إعادة رفعه."
        );
    }
});

bot.on("text", async ctx => {
    const session = sessions.get(ctx.from.id);

    if (!session || session.step !== "title") {
        return;
    }

    const title = ctx.message.text.trim();

    if (title.length < 3 || title.length > 200) {
        return ctx.reply(
            "اجعل العنوان بين 3 و200 حرف."
        );
    }

    session.title = title;
    session.step = "department";

    await ctx.reply(
        "اختر التخصص:",
        departmentKeyboard()
    );
});

bot.catch((error, ctx) => {
    console.error(
        "Bot error:",
        error.message
    );
});

async function start() {
    if (!process.env.ADMIN_BOT_TOKEN) {
        throw new Error("ADMIN_BOT_TOKEN غير مضبوط.");
    }

    if (ADMIN_IDS.length === 0) {
        throw new Error("ADMIN_IDS غير مضبوط.");
    }

    await query("SELECT 1");

    await bot.launch();

    console.log("Admin bot started successfully.");
}

start().catch(error => {
    console.error("Failed to start admin bot:",
