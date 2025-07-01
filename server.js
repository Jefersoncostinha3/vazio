const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

// Certifique-se de que os modelos de usuário e mensagem estão corretos e no caminho certo
const User = require('./models/User');
const Message = require('./models/Message'); // Importa o modelo de mensagem

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Conexão com o MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB conectado com sucesso!');
    } catch (error) {
        console.error(`Erro ao conectar ao MongoDB: ${error.message}`);
        process.exit(1); // Sai do processo se a conexão falhar
    }
};
connectDB();

// Middleware para analisar corpos de requisição JSON
app.use(express.json());
// Servir arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// --- Rotas de Autenticação (REST API) ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    console.log('Requisição de registro recebida:', { username, password });
    try {
        const userExists = await User.findOne({ username });
        if (userExists) {
            return res.status(400).json({ message: 'Nome de usuário já existe.' });
        }
        const user = await User.create({ username, password });
        res.status(201).json({ message: 'Usuário registrado com sucesso!', username: user.username });
    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({ message: 'Erro no servidor ao registrar usuário.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    console.log('Requisição de login recebida:', { username, password });
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ message: 'Credenciais inválidas.' });
        }
        const isMatch = await user.matchPassword(password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Credenciais inválidas.' });
        }
        res.status(200).json({ message: 'Login bem-sucedido!', username: user.username });
    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ message: 'Erro no servidor ao fazer login.' });
    }
});

// --- Lógica do Chat (Socket.IO) ---
const users = {}; // Armazena o mapeamento socket.id -> username
const rooms = { 'público': new Set() }; // Armazena roomName -> Set de socket.ids

// Função para emitir a lista de salas ativas para todos os clientes
async function emitActiveRooms() {
    const activeRooms = {};
    for (const roomName in rooms) {
        // Filtra salas que têm pelo menos um usuário conectado
        if (rooms[roomName].size > 0) {
            activeRooms[roomName] = Array.from(rooms[roomName]).map(socketId => users[socketId]);
        }
    }
    io.emit('active-rooms-list', activeRooms);
}

io.on('connection', (socket) => {
    console.log('Um usuário se conectou:', socket.id);

    socket.on('set-username', (username) => {
        // Esta parte do `set-username` pode ser removida se o login já cuida disso.
        // No fluxo atual, o `myUsername` no frontend é definido após o login bem-sucedido
        // e então um `join-room` é emitido. O `username` para `join-room` é o que importa.
        // A lógica de `users[socket.id] = username` é mais apropriada dentro do 'join-room'
        // ou após o login ser validado, para associar o socket.id ao usuário logado.
        // Para a integração que fizemos, 'join-room' é o ponto principal para isso.
        // Mantenho aqui por segurança, mas o 'join-room' é o que realmente associa.
        users[socket.id] = username;
        console.log(`Usuário ${username} definido para socket ${socket.id}`);
        // Considera o usuário na sala padrão 'público' ao se conectar
        // Isso pode ser redundante se 'join-room' já é chamado após login.
        //socket.join('público');
        //rooms['público'].add(socket.id);
        //io.to('público').emit('user-connected', username);
        emitActiveRooms();
    });

    socket.on('disconnect', () => {
        const username = users[socket.id]; // Pega o username antes de deletar
        console.log(`Usuário ${username || socket.id} desconectou.`);

        // Remove o usuário de todas as salas em que ele estava
        for (const roomName in rooms) {
            if (rooms[roomName].has(socket.id)) {
                rooms[roomName].delete(socket.id);
                // Notifica a sala que o usuário desconectou, se houver um username
                if (username) {
                    io.to(roomName).emit('user-disconnected', username);
                }
            }
        }
        delete users[socket.id]; // Remove o usuário do mapeamento global
        emitActiveRooms();
    });

    socket.on('chat-message', async (msg) => {
        const { username, room, message, audio, image, type } = msg; // Adicionado 'image'
        const normalizedRoomName = room.toLowerCase();

        // Salvar a mensagem no banco de dados
        try {
            const newMessage = new Message({
                username,
                room: normalizedRoomName,
                type,
                timestamp: new Date()
            });

            if (type === 'text') {
                newMessage.message = message;
            } else if (type === 'audio') {
                newMessage.audio = audio;
            } else if (type === 'image') { // NOVO: Lidar com mensagem de imagem
                newMessage.image = image;
                if (message) { // Permite texto junto com a imagem (opcional)
                    newMessage.message = message;
                }
            }

            await newMessage.save();
            console.log('Mensagem salva no DB:', newMessage);

            // Reemitir a mensagem para a sala
            io.to(normalizedRoomName).emit('chat-message', newMessage);
        } catch (error) {
            console.error('Erro ao salvar ou emitir mensagem:', error);
            socket.emit('room-error', 'Erro ao enviar mensagem.');
        }
    });

    socket.on('create-room', async (roomName, username) => {
        const normalizedRoomName = roomName.toLowerCase();
        if (rooms[normalizedRoomName]) {
            socket.emit('room-error', `A sala "${roomName}" já existe.`);
            return;
        }

        rooms[normalizedRoomName] = new Set();
        console.log(`Sala "${roomName}" criada por ${username}.`);
        socket.emit('room-created', roomName); // Informa o criador que a sala foi criada
        // Após criar, o criador é automaticamente movido para a nova sala
        // (o cliente então emitirá um 'join-room' para essa nova sala)
        await emitActiveRooms();
    });

    socket.on('join-room', async (roomName, username) => {
        const normalizedRoomName = roomName.toLowerCase();

        // Primeiro, verifique se a sala existe. Se não, crie-a.
        if (!rooms[normalizedRoomName]) {
            // Se a sala não existe, crie-a antes de juntar
            rooms[normalizedRoomName] = new Set();
            console.log(`Sala "${roomName}" não existia e foi criada por ${username} ao entrar.`);
            // Opcional: emitir um evento 'room-created' para outros clientes também
            // io.emit('room-created', roomName); // Se quiser notificar todos
        }

        // Deixar as salas antigas, exceto o próprio socket.id (que é uma "sala" privada)
        for (const room of socket.rooms) {
            if (room !== socket.id) { // Não queremos sair do próprio socket.id
                socket.leave(room);
                const currentRoomSet = rooms[room];
                if (currentRoomSet) {
                    currentRoomSet.delete(socket.id);
                }
            }
        }

        // Adicionar o usuário ao mapeamento global (se ainda não estiver lá, ou atualizar)
        users[socket.id] = username;
        
        socket.join(normalizedRoomName); // O Socket.IO sempre usa lowercase para o nome da sala ao fazer join/emit
        rooms[normalizedRoomName].add(socket.id);

        console.log(`Usuário ${username} entrou na sala: ${normalizedRoomName}`);
        socket.emit('room-joined', roomName); // Envia o nome ORIGINAL da sala para o frontend (para exibir)
        io.to(normalizedRoomName).emit('user-connected', username); // Emite para a sala (minúsculas)

        // Carrega mensagens antigas para a sala recém-entrada
        const historicalMessages = await Message.find({ room: normalizedRoomName })
                                                    .sort({ timestamp: 1 }) // Ordena do mais antigo para o mais novo
                                                    .limit(50); // Limita às últimas 50 mensagens
        socket.emit('previous-messages', historicalMessages);

        await emitActiveRooms();
    });

    socket.on('request-active-rooms', async () => {
        await emitActiveRooms();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
