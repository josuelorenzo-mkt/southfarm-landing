import { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from './db';

const JWT_SECRET = process.env.JWT_SECRET || 'southfarm-secret-change-in-production-2026';
const JWT_EXPIRES = '7d';

export const authRouter = Router();

// Helper: generate JWT
function signToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// Helper: auth middleware
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { userId: number };
    (req as any).userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// POST /api/auth/register
authRouter.post('/register', (req: Request, res: Response) => {
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

  const token = signToken(result.lastInsertRowid as number);
  res.status(201).json({
    token,
    user: { id: result.lastInsertRowid, email, name },
  });
});

// POST /api/auth/login
authRouter.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'email y password son requeridos' });
    return;
  }

  const user: any = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
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
authRouter.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user: any = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get((req as any).userId);
  if (!user) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }
  res.json({ user });
});
