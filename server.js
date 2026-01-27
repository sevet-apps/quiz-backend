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

// --- СОСТОЯНИЕ ИГРЫ ---
let gameState = {
    7: { currentIndex: -1 },
    8: { currentIndex: -1 },
    9: { currentIndex: -1 }
};

// --- API ---

app.get('/api/questions/:classLevel', async (req, res) => {
    const { classLevel } = req.params;
    const { data, error } = await supabase
        .from('quiz_questions')
        .select('id, question_text, options')
        .eq('class_level', classLevel)
        .order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ГЛАВНОЕ ИЗМЕНЕНИЕ: ЛОГИКА ПОДСЧЕТА БАЛЛОВ
app.post('/api/submit', async (req, res) => {
    const { teamName, classLevel, answers } = req.body;
    
    // 1. Проверяем правильность текущего ответа (приходит 1 ответ)
    const { data: correctData } = await supabase
        .from('quiz_questions')
        .select('id, correct_index')
        .eq('class_level', classLevel);

    let pointsToAdd = 0;
    if (answers && answers.length > 0) {
        answers.forEach(ans => {
            const question = correctData.find(q => q.id === ans.question_id);
            if (question && question.correct_index === ans.selected_index) {
                pointsToAdd = 1; // За правильный ответ даем 1 балл
            }
        });
    }

    // 2. Ищем, есть ли уже такая команда в базе
    const { data: existingTeam } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('team_name', teamName)
        .eq('class_level', classLevel)
        .single(); // Берем одну запись

    let newScore = 0;

    if (existingTeam) {
        // ОБНОВЛЯЕМ (UPDATE)
        newScore = existingTeam.score + pointsToAdd;
        // Считаем процент (всего 10 вопросов)
        const newPercent = Math.round((newScore / 10) * 100);

        await supabase
            .from('quiz_results')
            .update({ score: newScore, percentage: newPercent })
            .eq('id', existingTeam.id);
    } else {
        // СОЗДАЕМ (INSERT) - только если команды еще нет
        newScore = pointsToAdd;
        const newPercent = Math.round((newScore / 10) * 100);

        await supabase.from('quiz_results').insert({
            team_name: teamName,
            class_level: classLevel,
            score: newScore,
            percentage: newPercent
        });
    }

    res.json({ success: true });
});

app.get('/api/leaderboard/:classLevel', async (req, res) => {
    const { classLevel } = req.params;
    const { data } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('class_level', classLevel)
        .order('score', { ascending: false }) // Сортируем по баллам
        .limit(50);
    res.json(data);
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('join_class', (classLevel) => {
        socket.join(`class_${classLevel}`);
        const state = gameState[classLevel];
        if(state) socket.emit('sync_state', state); 
    });

    // Учитель: Следующий вопрос
    socket.on('teacher_next_question', (classLevel) => {
        if (!gameState[classLevel]) return;
        gameState[classLevel].currentIndex++;
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });

    // Учитель: Сброс
    socket.on('teacher_reset', (classLevel) => {
        if (!gameState[classLevel]) return;
        gameState[classLevel].currentIndex = -1;
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));