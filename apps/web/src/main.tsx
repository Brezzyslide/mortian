import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { brand } from '@project/domain';
import { App } from './App';
import './styles.css';

document.title = brand.name;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
