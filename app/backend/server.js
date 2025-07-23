const http = require('http');
const express = require('express');
const { Server } = require("socket.io");
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.GLITCH_URL || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

const port = process.env.PORT || 8000;

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Routes pour les modes solo
app.get('/solo-genshin', (req, res) => {
    res.sendFile(path.join(__dirname, 'memorysolo/MemoryGenshinLocal/MemoryLancerlejeuici.html'));
});

app.get('/solo-wuwa', (req, res) => {
    res.sendFile(path.join(__dirname, 'memorysolo/memorywuwaLocal/MemorywuwaLancerlejeuici.html'));
});

app.get('/simon', (req, res) => {
    res.sendFile(path.join(__dirname, 'simon.html'));
});

app.get('/jeuattention', (req, res) => {
    res.sendFile(path.join(__dirname, 'jeuattention/jeuattention.html'));
});

const rooms = new Map();
const MAX_ROOMS = 5;

// Stockage des sessions et des mappings d'images
const gameSessions = new Map();
const imageEncryptionMap = new Map();

// Fonction pour créer un ID unique pour les images cryptées
function generateEncryptedImageId() {
    return `img_${crypto.randomBytes(8).toString('hex')}`;
}

const DEFAULT_THEME = {
    name: 'default',
    images: [
        'nahida.png', 'furina.png', 'mavuika.png', 'kachina.png', 'yelan.png', 'itto.png',
        'raiden.png', 'sayu.png', 'ayaka.png', 'bennett.png', 'kazu.png', 'zhongli.png',
        'tarta.png', 'venti.png', 'klee.png', 'qiqi.png', 'image2diluc.png', 'image1.png'
    ],
    cardBack: 'doscartes.png',
    background: 'backgroundwuwa.png'
};

const WUWA_THEME = {
    name: 'wuwa',
    images: [
        'imagewuwa/Abby.png', 'imagewuwa/camellya.png', 'imagewuwa/Changli.png', 'imagewuwa/jinshi.png', 
        'imagewuwa/Lingyang.png', 'imagewuwa/Roccia.png', 'imagewuwa/shorekeeeper.png', 'imagewuwa/Verina.png', 
        'imagewuwa/yangyang.png', 'imagewuwa/Zhezhi.png', 'imagewuwa/Carlotta.png', 'imagewuwa/chixia.png', 
        'imagewuwa/Jinshi2.png', 'imagewuwa/Jiyan.png', 'imagewuwa/Pheobe.png', 'imagewuwa/rover.png', 
        'imagewuwa/Xiangliyao.png', 'imagewuwa/Yinlin.png'
    ],
    cardBack: 'imagewuwa/doscartes2.png',
    background: 'imagewuwa/backgroundwuwa2.png'
};

// Génération de token de session pour identification sécurisée
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Création d'un état de jeu initial
function createGameState() {
    const sessionToken = generateSessionToken();
    return {
        cards: [], // Stockage côté serveur uniquement
        encryptedCards: [], // Identifiants cryptés pour les images
        imageMapping: new Map(), // Mapping entre IDs cryptés et images réelles
        sessionToken: sessionToken,
        flippedCards: [],
        matchedIndexes: new Set(),
        playerTurn: 1,
        scores: { 1: 0, 2: 0 },
        players: {},
        maxPlayers: 2,
        isChecking: false,
        gameStarted: false,
        difficulty: 'medium',
        theme: DEFAULT_THEME,
        gridSize: { rows: 4, cols: 6 },
        lastAction: Date.now(),
        playerActions: new Map() // Tracking des actions par joueur
    };
}

// Initialisation du jeu avec cryptage des images
function initializeGame(gameState, difficulty = 'medium', theme = DEFAULT_THEME) {
    gameState.theme = theme;
    gameState.sessionToken = generateSessionToken();
    gameState.imageMapping = new Map();

    switch(difficulty) {
        case 'easy':
            gameState.gridSize = { rows: 4, cols: 4 };
            break;
        case 'medium':
            gameState.gridSize = { rows: 4, cols: 6 };
            break;
        case 'hard':
            gameState.gridSize = { rows: 6, cols: 6 };
            break;
        default:
            gameState.gridSize = { rows: 4, cols: 6 };
    }

    const totalCards = gameState.gridSize.rows * gameState.gridSize.cols;
    const pairsCount = totalCards / 2;
    const selectedImages = theme.images.slice(0, pairsCount);

    // Génération des cartes avec ordre aléatoire
    gameState.cards = [...selectedImages, ...selectedImages].sort(() => Math.random() - 0.5);
    
    // Création des identifiants cryptés pour chaque carte
    gameState.encryptedCards = gameState.cards.map(card => {
        const encryptedId = generateEncryptedImageId();
        gameState.imageMapping.set(encryptedId, card);
        return encryptedId;
    });
    
    gameState.flippedCards = [];
    gameState.matchedIndexes.clear();
    gameState.scores = { 1: 0, 2: 0 };
    gameState.playerTurn = 1;
    gameState.isChecking = false;
    gameState.gameStarted = false;
    gameState.difficulty = difficulty;
    gameState.lastAction = Date.now();
    gameState.playerActions.clear();
}

// Validation des actions du joueur (protection anti-spam)
function validatePlayerAction(gameState, playerId, actionType) {
    const now = Date.now();
    const playerActions = gameState.playerActions.get(playerId) || [];
    
    // Vérifier la fréquence des actions (max 1 action par seconde)
    const recentActions = playerActions.filter(time => now - time < 1000);
    if (recentActions.length > 1) {
        console.log(`⚠️ Action trop rapide détectée pour ${playerId}`);
        return false;
    }
    
    // Ajouter l'action actuelle
    playerActions.push(now);
    if (playerActions.length > 10) {
        playerActions.shift(); // Garder seulement les 10 dernières actions
    }
    gameState.playerActions.set(playerId, playerActions);
    
    return true;
}

// Recherche d'une salle disponible ou création d'une nouvelle salle
function getAvailableRoom() {
    for (const [roomId, room] of rooms.entries()) {
        if (Object.keys(room.players).length < 2) {
            return roomId;
        }
    }

    if (rooms.size < MAX_ROOMS) {
        const roomId = `room_${rooms.size + 1}`;
        const gameState = createGameState();
        initializeGame(gameState);
        rooms.set(roomId, gameState);
        return roomId;
    }

    return null;
}

// Mise en place des routes pour les images cryptées
app.get('/game-image/:imageId', (req, res) => {
    const { imageId } = req.params;
    const roomId = req.query.room;
    
    if (!roomId || !imageId) {
        return res.status(404).send('Image not found');
    }
    
    const gameState = rooms.get(roomId);
    if (!gameState || !gameState.imageMapping.has(imageId)) {
        return res.status(404).send('Image not found');
    }
    
    // Récupération du chemin réel de l'image
    const imagePath = gameState.imageMapping.get(imageId);
    res.sendFile(path.join(__dirname, imagePath));
});

io.on('connection', (socket) => {
    console.log(`🔹 Joueur connecté : ${socket.id}`);

    socket.emit('roomsList', Array.from(rooms.entries()).map(([roomId, room]) => ({
        roomId,
        players: Object.keys(room.players).length,
        difficulty: room.difficulty
    })));

    socket.on('joinRoom', (roomId) => {
        const targetRoom = rooms.get(roomId);
        if (!targetRoom || Object.keys(targetRoom.players).length >= 2) {
            socket.emit('error', 'Salle pleine ou invalide');
            return;
        }

        socket.join(roomId);
        socket.roomId = roomId;

        const playerNumber = Object.keys(targetRoom.players).length === 0 ? 1 : 2;
        targetRoom.players[socket.id] = playerNumber;
        socket.emit('playerNumber', playerNumber);

        // Envoi sécurisé de l'état du jeu avec les IDs cryptés
        socket.emit('gameState', {
            roomId: roomId,
            encryptedCards: targetRoom.encryptedCards,
            cardBack: targetRoom.theme.cardBack,
            scores: targetRoom.scores,
            playerTurn: targetRoom.playerTurn,
            matchedIndexes: Array.from(targetRoom.matchedIndexes),
            difficulty: targetRoom.difficulty,
            theme: {
                name: targetRoom.theme.name,
                cardBack: targetRoom.theme.cardBack,
                background: targetRoom.theme.background
            },
            gridSize: targetRoom.gridSize,
            sessionToken: targetRoom.sessionToken
        });

        if (Object.keys(targetRoom.players).length === 2) {
            targetRoom.gameStarted = true;
            io.to(roomId).emit('gameStarted', {
                difficulty: targetRoom.difficulty,
                gridSize: targetRoom.gridSize
            });
        } else {
            socket.emit('waitingForPlayer');
        }

        io.emit('roomsList', Array.from(rooms.entries()).map(([id, room]) => ({
            roomId: id,
            players: Object.keys(room.players).length,
            difficulty: room.difficulty
        })));
    });

    socket.on('createRoom', (difficulty = 'medium', themeName = 'default') => {
        const roomId = getAvailableRoom();
        if (roomId) {
            const gameState = rooms.get(roomId);
            const theme = themeName === 'wuwa' ? WUWA_THEME : DEFAULT_THEME;
            initializeGame(gameState, difficulty, theme);
            socket.emit('roomCreated', roomId);
        } else {
            socket.emit('error', 'Nombre maximum de salles atteint');
        }
    });

    socket.on('resetGame', () => {
        const roomId = socket.roomId;
        const gameState = rooms.get(roomId);
        if (gameState) {
            initializeGame(gameState, gameState.difficulty, gameState.theme);
            io.to(roomId).emit('gameReset');
            
            // Envoi sécurisé du nouvel état avec images cryptées
            io.to(roomId).emit('gameState', {
                roomId: roomId,
                encryptedCards: gameState.encryptedCards,
                cardBack: gameState.theme.cardBack,
                scores: gameState.scores,
                playerTurn: gameState.playerTurn,
                matchedIndexes: Array.from(gameState.matchedIndexes),
                difficulty: gameState.difficulty,
                theme: {
                    name: gameState.theme.name,
                    cardBack: gameState.theme.cardBack,
                    background: gameState.theme.background
                },
                gridSize: gameState.gridSize,
                sessionToken: gameState.sessionToken
            });
        }
    });

    socket.on('flipCard', (data) => {
        const roomId = socket.roomId;
        const gameState = rooms.get(roomId);

        if (!gameState || !gameState.gameStarted) {
            socket.emit('error', 'En attente du deuxième joueur...');
            return;
        }

        try {
            const { index, sessionToken } = data;
            
            // Validation du token de session
            if (sessionToken !== gameState.sessionToken) {
                console.log(`⚠️ Token de session invalide pour ${socket.id}`);
                socket.emit('error', 'Session invalide');
                return;
            }
            
            // Validation anti-spam
            if (!validatePlayerAction(gameState, socket.id, 'flipCard')) {
                socket.emit('error', 'Action trop rapide détectée');
                return;
            }
            
            const player = gameState.players[socket.id];
            if (!player || player !== gameState.playerTurn || gameState.isChecking) return;
            if (gameState.matchedIndexes.has(index) || gameState.flippedCards.some(c => c.index === index)) return;

            // Révélation sécurisée de la carte avec URL d'image cryptée
            const encryptedImageId = gameState.encryptedCards[index];
            const imageUrl = `/game-image/${encryptedImageId}?room=${roomId}`;
            const originalImage = gameState.cards[index];
            
            gameState.flippedCards.push({ index, image: originalImage });
            
            // Envoi de la carte révélée avec URL cryptée
            io.to(roomId).emit('cardFlipped', { index, image: imageUrl });

            if (gameState.flippedCards.length === 2) {
                gameState.isChecking = true;
                setTimeout(() => checkMatch(roomId), 1000);
            }
        } catch (error) {
            console.error('Erreur lors du retournement de carte:', error);
            socket.emit('error', 'Une erreur est survenue');
        }
    });

    function checkMatch(roomId) {
        const gameState = rooms.get(roomId);
        if (!gameState) return;

        try {
            const [card1, card2] = gameState.flippedCards;

            if (card1.image === card2.image) {
                gameState.scores[gameState.playerTurn]++;
                gameState.matchedIndexes.add(card1.index);
                gameState.matchedIndexes.add(card2.index);
                io.to(roomId).emit('matchFound', {
                    indexes: [card1.index, card2.index],
                    scores: gameState.scores
                });

                if (gameState.matchedIndexes.size === gameState.cards.length) {
                    io.to(roomId).emit('gameOver', gameState.scores);
                }
            } else {
                io.to(roomId).emit('mismatch', { indexes: [card1.index, card2.index] });
                gameState.playerTurn = gameState.playerTurn === 1 ? 2 : 1;
            }
            gameState.flippedCards = [];
            gameState.isChecking = false;
            io.to(roomId).emit('turnChanged', gameState.playerTurn);
        } catch (error) {
            console.error('Erreur lors de la vérification des cartes:', error);
            gameState.flippedCards = [];
            gameState.isChecking = false;
        }
    }

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (roomId) {
            const gameState = rooms.get(roomId);
            if (gameState) {
                delete gameState.players[socket.id];
                gameState.playerActions.delete(socket.id);

                if (Object.keys(gameState.players).length === 0) {
                    rooms.delete(roomId);
                } else {
                    gameState.gameStarted = false;
                    io.to(roomId).emit('playerLeft');
                }

                io.emit('roomsList', Array.from(rooms.entries()).map(([id, room]) => ({
                    roomId: id,
                    players: Object.keys(room.players).length,
                    difficulty: room.difficulty
                })));
            }
        }
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`🎮 Serveur de jeu sécurisé actif sur le port ${port}`);
});