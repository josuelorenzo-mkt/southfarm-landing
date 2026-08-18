import { Request, Response, NextFunction } from 'express';
export declare const authRouter: import("express-serve-static-core").Router;
export declare function authMiddleware(req: Request, res: Response, next: NextFunction): void;
