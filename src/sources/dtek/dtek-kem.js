import { createDtekAdapter } from './adapter.js';

export default createDtekAdapter({
  id: 'dtek-kem',
  displayName: 'ДТЕК Київські електромережі',
  region: 'місто Київ',
  url: 'https://www.dtek-kem.com.ua/ua/shutdowns',
});
