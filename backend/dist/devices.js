import { Router } from 'express';
import db from './db';
import { authMiddleware } from './auth';
export const devicesRouter = Router();
devicesRouter.use(authMiddleware);
// POST /api/devices/register
devicesRouter.post('/register', (req, res) => {
    const userId = req.userId;
    const { device_id, device_name, android_version } = req.body;
    if (!device_id) {
        res.status(400).json({ error: 'device_id es requerido' });
        return;
    }
    const existing = db.prepare('SELECT id FROM devices WHERE user_id = ? AND device_id = ?').get(userId, device_id);
    if (existing) {
        res.json({ device: existing, message: 'Dispositivo ya registrado' });
        return;
    }
    const result = db.prepare('INSERT INTO devices (user_id, device_id, device_name, android_version) VALUES (?, ?, ?, ?)').run(userId, device_id, device_name || null, android_version || null);
    res.status(201).json({
        device: { id: result.lastInsertRowid, device_id, device_name, android_version },
    });
});
// GET /api/devices
devicesRouter.get('/', (req, res) => {
    const devices = db.prepare('SELECT * FROM devices WHERE user_id = ?').all(req.userId);
    res.json({ devices });
});
// DELETE /api/devices/:id
devicesRouter.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    if (result.changes === 0) {
        res.status(404).json({ error: 'Dispositivo no encontrado' });
        return;
    }
    res.json({ message: 'Dispositivo eliminado' });
});
