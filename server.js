const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helpers pour lire/écrire users.json
async function loadUsers() {
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return []; // si fichier manquant, retourne tableau vide
  }
}

async function saveUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// API d'inscription
app.post('/api/register', async (req, res) => {
  const { pseudo, password } = req.body;
  if (!pseudo || !password) return res.status(400).json({ ok: false, error: 'Pseudo et mot de passe requis' });

  const users = await loadUsers();
  if (users.find(u => u.pseudo.toLowerCase() === pseudo.toLowerCase())) {
    return res.status(400).json({ ok: false, error: 'Pseudo déjà pris' });
  }

  const hash = await bcrypt.hash(password, 10);
  users.push({ pseudo, passwordHash: hash });
  await saveUsers(users);
  res.json({ ok: true });
});

// API de login
app.post('/api/login', async (req, res) => {
  const { pseudo, password } = req.body;
  if (!pseudo || !password) return res.status(400).json({ ok: false, error: 'Pseudo et mot de passe requis' });

  const users = await loadUsers();
  const user = users.find(u => u.pseudo.toLowerCase() === pseudo.toLowerCase());
  if (!user) return res.status(400).json({ ok: false, error: 'Utilisateur introuvable' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ ok: false, error: 'Mot de passe incorrect' });

  res.json({ ok: true });
});

// ===================== Socket.io =====================
let socketsUser = {};    // socketId -> pseudo
let userSocket = {};     // pseudo -> socketId (empêcher double connexion)
let scores = {};         // pseudo -> score

// Quiz server-side (questions, timing)
let questionsBank = [
  { question: "Qui chante 'Shape of You' ?", options: ["Ed Sheeran","Justin Bieber","Shawn Mendes","Drake"], correct: "Ed Sheeran" },
  { question: "Quel groupe a sorti 'The Dark Side of the Moon' ?", options: ["Pink Floyd","Queen","The Beatles","Nirvana"], correct: "Pink Floyd" },
  { question: "Quelle chanteuse a interprété 'Rolling in the Deep' ?", options: ["Adele","Dua Lipa","Sia","Lady Gaga"], correct: "Adele" },
  { question: "Qui a chanté 'Bad Guy' ?", options: ["Billie Eilish","Lorde","Olivia Rodrigo","Doja Cat"], correct: "Billie Eilish" },
  { question: "Quel artiste est surnommé 'The King of Pop' ?", options: ["Michael Jackson","Elvis Presley","Prince","Madonna"], correct: "Michael Jackson" }
];

let roundQuestions = [];      // questions de la ronde actuelle
let qIndex = 0;
let quizRunning = false;
let questionIntervalMs = 25_000; // 25 secondes entre chaque question
let questionTimer = null;

// Fonction pour (re)démarrer une ronde de quiz — mélange les questions
function startNewRound() {
  roundQuestions = shuffle([...questionsBank]);
  qIndex = 0;
  // reset scores
  Object.keys(scores).forEach(p => scores[p] = 0);
  quizRunning = true;
  io.emit('message', '🔔 Nouveau quiz lancé !');
  sendQuestion();
  // timer pour envoyer les questions périodiquement
  if (questionTimer) clearInterval(questionTimer);
  questionTimer = setInterval(() => {
    qIndex++;
    if (qIndex >= roundQuestions.length) {
      endRound();
    } else {
      sendQuestion();
    }
  }, questionIntervalMs);
}

function sendQuestion() {
  if (!roundQuestions[qIndex]) return;
  const q = roundQuestions[qIndex];
  io.emit('question', { index: qIndex, question: q.question, options: q.options });
  io.sockets.sockets.forEach(s => s.answered = false);
}

function endRound() {
  quizRunning = false;
  if (questionTimer) clearInterval(questionTimer);
  const entries = Object.entries(scores);
  if (entries.length === 0) {
    io.emit('message', '🔔 Fin du quiz : personne n\'a participé.');
  } else {
    entries.sort((a,b)=> b[1]-a[1]);
    const topScore = entries[0][1];
    const winners = entries.filter(e => e[1] === topScore).map(e => e[0]);
    io.emit('message', `🏆 Gagnant(s) : ${winners.join(', ')} — score : ${topScore}`);
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Redémarrage automatique à minuit
setInterval(() => {
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes();

  if (hh === 23 && mm === 50) {
    io.emit('message', '⏳ Résultats imminents...');
    endRound();
  }

  if (hh === 0 && mm === 0) {
    startNewRound();
  }
}, 60_000);

// Socket logic
io.on('connection', (socket) => {
  console.log('✅ Nouveau client connecté:', socket.id);

  socket.on('authenticate', (pseudo) => {
    if (userSocket[pseudo]) {
      socket.emit('auth-failed', 'Ce pseudo est déjà connecté ailleurs.');
      return;
    }
    socketsUser[socket.id] = pseudo;
    userSocket[pseudo] = socket.id;
    if (!scores[pseudo]) scores[pseudo] = 0;
    io.emit('users', Object.values(socketsUser));
    socket.emit('auth-ok', 'Authentifié');

    if (!quizRunning) startNewRound();
  });

  socket.on('chatMessage', (texte) => {
    const pseudo = socketsUser[socket.id] || 'Anonyme';
    io.emit('message', `${pseudo}: ${texte}`);
  });

  socket.on('reponseQuiz', (data) => {
    const pseudo = socketsUser[socket.id];
    if (!pseudo || !quizRunning || socket.answered) return;
    socket.answered = true;

    const q = roundQuestions[data.index];
    if (!q) return;

    if (data.choix === q.correct) {
      scores[pseudo] = (scores[pseudo] || 0) + 1;
      io.emit('message', `✅ ${pseudo} a répondu correctement !`);
    } else {
      io.emit('message', `❌ ${pseudo} a répondu… (incorrect)`);
    }

    const allAnswered = Array.from(io.sockets.sockets.values())
      .filter(s => socketsUser[s.id])
      .every(s => s.answered);

    if (allAnswered) {
      qIndex++;
      if (qIndex >= roundQuestions.length) endRound();
      else sendQuestion();
    }
  });

  socket.on('disconnect', () => {
    const pseudo = socketsUser[socket.id];
    if (pseudo) {
      delete userSocket[pseudo];
      delete socketsUser[socket.id];
      io.emit('users', Object.values(socketsUser));
    }
    console.log('👋 Client déconnecté:', socket.id);
  });
});

// 🔴 REDIRECTION IMPORTANTE : / → /quiz.html
app.get('/', (req, res) => {
  res.redirect('/quiz.html');
});

// Démarrage serveur
server.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur : http://localhost:${PORT}`);
});