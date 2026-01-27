require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- СОСТОЯНИЕ ИГРЫ (В ПАМЯТИ) ---
// Храним текущий индекс вопроса для каждого класса
// -1 = ожидание начала (Учитель еще не нажал старт)
// 0 = 1-й вопрос, 1 = 2-й вопрос...
let gameState = {
    7: { currentIndex: -1, showLeaderboard: false },
    8: { currentIndex: -1, showLeaderboard: false },
    9: { currentIndex: -1, showLeaderboard: false }
};

// --- API ЗАПРОСЫ ---

// 1. Получить вопросы
app.get('/api/questions/:classLevel', async (req, res) => {
    const { classLevel } = req.params;
    const { data, error } = await supabase
        .from('quiz_questions')
        .select('id, question_text, options')
        .eq('class_level', classLevel)
        .order('id'); // Сортируем по ID, чтобы у всех был один порядок
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. Сохранить ответ ученика
app.post('/api/submit', async (req, res) => {
    const { teamName, classLevel, answers } = req.body;
    
    // Получаем правильные ответы из базы
    const { data: correctData } = await supabase
        .from('quiz_questions')
        .select('id, correct_index')
        .eq('class_level', classLevel);

    let score = 0;
    // Считаем баллы
    if (answers && answers.length > 0) {
        answers.forEach(ans => {
            const question = correctData.find(q => q.id === ans.question_id);
            if (question && question.correct_index === ans.selected_index) score++;
        });
    }

    const percentage = correctData.length > 0 ? Math.round((score / correctData.length) * 100) : 0;

    // Сохраняем результат в базу Supabase
    await supabase.from('quiz_results').insert({
        team_name: teamName,
        class_level: classLevel,
        score: score,
        percentage: percentage
    });

    res.json({ success: true, score, percentage });
});

// 3. Таблица лидеров
app.get('/api/leaderboard/:classLevel', async (req, res) => {
    const { classLevel } = req.params;
    const { data } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('class_level', classLevel)
        .order('percentage', { ascending: false }) // У кого больше % - тот выше
        .order('created_at', { ascending: true })  // Кто раньше сдал - тот выше
        .limit(50);
    
    res.json(data);
});

// --- ЛОГИКА SOCKET.IO (СИНХРОНИЗАЦИЯ) ---
io.on('connection', (socket) => {
    
    // Когда кто-то (ученик или учитель) заходит
    socket.on('join_class', (classLevel) => {
        socket.join(`class_${classLevel}`);
        
        // Сразу отправляем ему текущее состояние (какой вопрос сейчас идет)
        const state = gameState[classLevel];
        if(state) {
            socket.emit('sync_state', state); 
        }
    });

    // --- КОМАНДЫ ОТ УЧИТЕЛЯ ---
    
    // Учитель нажал "Следующий вопрос"
    socket.on('teacher_next_question', (classLevel) => {
        if (!gameState[classLevel]) return;
        
        gameState[classLevel].currentIndex++; // Увеличиваем номер вопроса
        gameState[classLevel].showLeaderboard = false; // Убираем таблицу лидеров
        
        // Говорим ВСЕМ в этом классе переключить экран
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });

    // Учитель нажал "Показать таблицу" (Пауза)
    socket.on('teacher_show_leaderboard', (classLevel) => {
        if (!gameState[classLevel]) return;

        gameState[classLevel].showLeaderboard = true;
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });

    // Учитель нажал "Сброс игры"
    socket.on('teacher_reset', (classLevel) => {
        if (!gameState[classLevel]) return;
        
        gameState[classLevel].currentIndex = -1; // Возвращаем в начало
        gameState[classLevel].showLeaderboard = false;
        
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));