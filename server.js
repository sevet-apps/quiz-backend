const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors()); // Разрешаем доступ с GitHub Pages
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Подключение к базе (ключи возьмем из настроек Render)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Получить вопросы
app.get('/api/questions/:classLevel', async (req, res) => {
    const { classLevel } = req.params;
    const { data, error } = await supabase
        .from('quiz_questions')
        .select('id, question_text, options')
        .eq('class_level', classLevel);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Проверить ответы
app.post('/api/submit', async (req, res) => {
    const { teamName, classLevel, answers } = req.body;
    
    // Получаем правильные ответы
    const { data: correctData } = await supabase
        .from('quiz_questions')
        .select('id, correct_index')
        .eq('class_level', classLevel);

    let score = 0;
    answers.forEach(ans => {
        const question = correctData.find(q => q.id === ans.question_id);
        if (question && question.correct_index === ans.selected_index) score++;
    });

    const percentage = correctData.length > 0 ? Math.round((score / correctData.length) * 100) : 0;

    await supabase.from('quiz_results').insert({
        team_name: teamName,
        class_level: classLevel,
        score: score,
        percentage: percentage
    });

    // Оповещаем всех
    io.to(`class_${classLevel}`).emit('leaderboard_update');
    res.json({ success: true, score, percentage });
});

// Получить таблицу лидеров
app.get('/api/leaderboard/:classLevel', async (req, res) => {
    const { classLevel } = req.params;
    const { data } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('class_level', classLevel)
        .order('percentage', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(50);
    res.json(data);
});

io.on('connection', (socket) => {
    socket.on('join_class', (lvl) => socket.join(`class_${lvl}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));