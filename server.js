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
// -1 = Игра не началась (Лобби)
// 0, 1, 2... = Индекс текущего вопроса
// 'finished' = Таблица лидеров
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

app.post('/api/submit', async (req, res) => {
    // teamName теперь по сути Имя Ученика
    const { teamName, classLevel, answers } = req.body;
    
    const { data: correctData } = await supabase
        .from('quiz_questions')
        .select('id, correct_index')
        .eq('class_level', classLevel);

    let pointsToAdd = 0;
    if (answers && answers.length > 0) {
        answers.forEach(ans => {
            const question = correctData.find(q => q.id === ans.question_id);
            if (question && question.correct_index === ans.selected_index) {
                pointsToAdd = 1; 
            }
        });
    }

    // Ищем ученика по имени
    const { data: existingUser } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('team_name', teamName)
        .eq('class_level', classLevel)
        .single();

    let newScore = 0;
    if (existingUser) {
        newScore = existingUser.score + pointsToAdd;
        const newPercent = Math.round((newScore / 10) * 100); // Предполагаем 10 вопросов
        await supabase.from('quiz_results').update({ score: newScore, percentage: newPercent }).eq('id', existingUser.id);
    } else {
        newScore = pointsToAdd;
        const newPercent = Math.round((newScore / 10) * 100);
        await supabase.from('quiz_results').insert({ team_name: teamName, class_level: classLevel, score: newScore, percentage: newPercent });
    }
    res.json({ success: true });
});

app.get('/api/leaderboard/:classLevel', async (req, res) => {
    const { classLevel } = req.params;
    const { data } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('class_level', classLevel)
        .order('score', { ascending: false })
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

    // КОМАНДА УЧИТЕЛЯ: "СЛЕДУЮЩИЙ ВОПРОС" (или начать)
    socket.on('teacher_next', (classLevel) => {
        if (!gameState[classLevel]) return;
        
        if (gameState[classLevel].currentIndex === 'finished') {
            // Если игра была закончена, ничего не делаем или сбрасываем (тут по логике лучше сброс)
            return; 
        }

        // Переключаем индекс
        gameState[classLevel].currentIndex++;
        
        // Отправляем всем новое состояние
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });

    // КОМАНДА УЧИТЕЛЯ: "ЗАВЕРШИТЬ / ПОКАЗАТЬ РЕЗУЛЬТАТЫ"
    socket.on('teacher_finish', (classLevel) => {
        if (!gameState[classLevel]) return;
        gameState[classLevel].currentIndex = 'finished';
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });

    // КОМАНДА УЧИТЕЛЯ: "СБРОС"
    socket.on('teacher_reset', (classLevel) => {
        if (!gameState[classLevel]) return;
        gameState[classLevel].currentIndex = -1; // Возвращаем в лобби
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));