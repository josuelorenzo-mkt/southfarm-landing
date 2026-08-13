import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from './db';
import { signSouthFarmJwt, verifySouthFarmJwt } from './jwt-config';
export const authRouter = Router();
// Helper: generate JWT
function signToken(userId) {
    return signSouthFarmJwt(userId);
}
// Helper: auth middleware
export function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Token requerido' });
        return;
    }
    try {
        const payload = verifySouthFarmJwt(header.slice(7));
        req.userId = payload.userId;
        next();
    }
    catch {
        res.status(401).json({ error: 'Token inválido' });
    }
}
// POST /api/auth/register
authRouter.post('/register', (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
        res.status(400).json({ error: 'email, password y name son requeridos' });
        return;
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
        res.status(409).json({ error: 'Email ya registrado' });
        return;
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)').run(email, hashedPassword, name);
    const token = signToken(result.lastInsertRowid);
    res.status(201).json({
        token,
        user: { id: result.lastInsertRowid, email, name },
    });
});
// POST /api/auth/login
authRouter.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        res.status(400).json({ error: 'email y password son requeridos' });
        return;
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        res.status(401).json({ error: 'Credenciales inválidas' });
        return;
    }
    const token = signToken(user.id);
    res.json({
        token,
        user: { id: user.id, email: user.email, name: user.name },
    });
});
// GET /api/auth/me
authRouter.get('/me', authMiddleware, (req, res) => {
    const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(req.userId);
    if (!user) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
    res.json({ user });
});
