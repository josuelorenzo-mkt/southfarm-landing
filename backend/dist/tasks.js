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
    const result = db.prepare('INSERT INTO task_runs (user_id, device_id, task_type, params, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, device_id, task_type, JSON.stringify(params || {}), 'pending', new Date().toISOString());
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
// GET /api/tasks/active — get active task for a device (for app polling)
tasksRouter.get('/active', (req, res) => {
    const userId = req.userId;
    const { device_id } = req.query;
    let query = 'SELECT tr.*, d.device_name, d.device_id as device_string FROM task_runs tr JOIN devices d ON tr.device_id = d.id WHERE tr.user_id = ? AND tr.status IN (\'pending\', \'running\', \'paused\')';
    const params = [userId];
    if (device_id) {
        query += ' AND d.device_id = ?';
        params.push(device_id);
    }
    query += ' ORDER BY tr.created_at DESC LIMIT 1';
    const run = db.prepare(query).get(...params);
    if (!run) {
        res.json({ active: false });
        return;
    }
    res.json({
        active: true,
        task: {
            id: run.id,
            task_type: run.task_type,
            status: run.status,
            params: JSON.parse(run.params || '{}'),
            created_at: run.created_at,
            device_name: run.device_name,
        }
    });
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
// PATCH /api/tasks/runs/:id/pause
tasksRouter.patch('/runs/:id/pause', (req, res) => {
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!run) {
        res.status(404).json({ error: 'No encontrada' });
        return;
    }
    db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('paused', run.id);
    res.json({ ok: true, status: 'paused' });
});
// PATCH /api/tasks/runs/:id/resume
tasksRouter.patch('/runs/:id/resume', (req, res) => {
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!run) {
        res.status(404).json({ error: 'No encontrada' });
        return;
    }
    db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', run.id);
    res.json({ ok: true, status: 'running' });
});
// PATCH /api/tasks/runs/:id/stop
tasksRouter.patch('/runs/:id/stop', (req, res) => {
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!run) {
        res.status(404).json({ error: 'No encontrada' });
        return;
    }
    db.prepare('UPDATE task_runs SET status = ?, completed_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), run.id);
    res.json({ ok: true, status: 'cancelled' });
});
