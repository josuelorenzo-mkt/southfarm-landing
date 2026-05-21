import { Router } from 'express';
import db from './db';
import { authMiddleware } from './auth';
export const tasksRouter = Router();
tasksRouter.use(authMiddleware);
// GET /api/tasks — list templates
tasksRouter.get('/', (_req, res) => {
    const tasks = db.prepare('SELECT * FROM task_templates').all();
    res.json({ tasks });
});
// POST /api/tasks/run — execute a task
tasksRouter.post('/run', (req, res) => {
    const userId = req.userId;
    const { task_type, device_id, params } = req.body;
    if (!task_type || !device_id) {
        res.status(400).json({ error: 'task_type y device_id son requeridos' });
        return;
    }
    // Verify device belongs to user
    const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(device_id, userId);
    if (!device) {
        res.status(404).json({ error: 'Dispositivo no encontrado' });
        return;
    }
    // Verify task type exists
    const template = db.prepare('SELECT * FROM task_templates WHERE task_type = ?').get(task_type);
    if (!template) {
        res.status(404).json({ error: 'Tipo de tarea no encontrado' });
        return;
    }
    const result = db.prepare('INSERT INTO task_runs (user_id, device_id, task_type, params, status) VALUES (?, ?, ?, ?, ?)').run(userId, device_id, task_type, JSON.stringify(params || {}), 'pending');
    // TODO: Actually trigger the task execution on the device via ADB
    // For now, mark as queued
    console.log(`[Task] Queued ${task_type} for device ${device_id} (run #${result.lastInsertRowid})`);
    res.status(201).json({
        task_run_id: result.lastInsertRowid,
        status: 'pending',
        message: 'Tarea encolada',
    });
});
// GET /api/tasks/runs — history
tasksRouter.get('/runs', (req, res) => {
    const runs = db.prepare('SELECT tr.*, d.device_name FROM task_runs tr JOIN devices d ON tr.device_id = d.id WHERE tr.user_id = ? ORDER BY tr.created_at DESC').all(req.userId);
    res.json({ runs });
});
// GET /api/tasks/runs/:id — status
tasksRouter.get('/runs/:id', (req, res) => {
    const run = db.prepare('SELECT tr.*, d.device_name FROM task_runs tr JOIN devices d ON tr.device_id = d.id WHERE tr.id = ? AND tr.user_id = ?').get(req.params.id, req.userId);
    if (!run) {
        res.status(404).json({ error: 'Ejecución no encontrada' });
        return;
    }
    res.json(run);
});
