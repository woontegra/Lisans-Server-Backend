import { Request } from 'express';

export function paramId(req: Request, name = 'id'): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}
