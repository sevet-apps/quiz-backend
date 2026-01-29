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

app.post('/api/submit', async (req, res) => {
    // Теперь принимаем userId (уникальный код)
    const { teamName, classLevel, answers, userId } = req.body;
    
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

    // ИЩЕМ ПО УНИКАЛЬНОМУ ID (user_uuid), А НЕ ПО ИМЕНИ
    const { data: existingUser } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('user_uuid', userId) 
        .eq('class_level', classLevel)
        .single();

    let newScore = 0;
    if (existingUser) {
        newScore = existingUser.score + pointsToAdd;
        const newPercent = Math.round((newScore / 10) * 100);
        // Обновляем имя тоже, вдруг исправил опечатку
        await supabase
            .from('quiz_results')
            .update({ score: newScore, percentage: newPercent, team_name: teamName }) 
            .eq('id', existingUser.id);
    } else {
        newScore = pointsToAdd;
        const newPercent = Math.round((newScore / 10) * 100);
        await supabase.from('quiz_results').insert({ 
            team_name: teamName, 
            class_level: classLevel, 
            score: newScore, 
            percentage: newPercent,
            user_uuid: userId // Сохраняем ID
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
        .order('score', { ascending: false })
        .limit(50);
    res.json(data);
});

async function updateOnlineCount(classLevel) {
    const sockets = await io.in(`class_${classLevel}`).fetchSockets();
    let studentCount = 0;
    for (const s of sockets) {
        if (!s.data.isTeacher) studentCount++;
    }
    io.to(`class_${classLevel}`).emit('online_count', studentCount);
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    
    socket.on('join_class', ({ classLevel, isTeacher }) => {
        socket.join(`class_${classLevel}`);
        socket.currentClass = classLevel;
        socket.data.isTeacher = isTeacher; 

        const state = gameState[classLevel];
        if(state) socket.emit('sync_state', state); 
        updateOnlineCount(classLevel);
    });

    socket.on('disconnect', () => {
        if (socket.currentClass) updateOnlineCount(socket.currentClass);
    });

    socket.on('teacher_next', (classLevel) => {
        if (!gameState[classLevel]) return;
        if (gameState[classLevel].currentIndex === 'finished') return; 

        gameState[classLevel].currentIndex++;
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });

    socket.on('teacher_finish', (classLevel) => {
        if (!gameState[classLevel]) return;
        gameState[classLevel].currentIndex = 'finished';
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });

    socket.on('teacher_reset', (classLevel) => {
        if (!gameState[classLevel]) return;
        gameState[classLevel].currentIndex = -1;
        io.to(`class_${classLevel}`).emit('sync_state', gameState[classLevel]);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));