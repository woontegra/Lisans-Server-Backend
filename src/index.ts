import app from './app';
import { config } from './config';

const port = config.port;

app.listen(port, () => {
  console.log(`Woontegra Lisans Server çalışıyor: http://localhost:${port}`);
});
