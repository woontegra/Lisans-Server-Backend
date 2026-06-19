import express from 'express';
import cors from 'cors';
import publicRoutes from './routes/public';
import adminRoutes from './routes/admin';
import integrationRoutes from './routes/integration';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'woontegra-lisans-server' });
});

app.use('/api/public/license', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/integrations/website', integrationRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı' });
});

export default app;
