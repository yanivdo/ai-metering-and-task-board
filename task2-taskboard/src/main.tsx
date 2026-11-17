import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHttpApi } from './api/http';
import { connectLive } from './api/live';
import { App } from './App';
import { createBoardStore } from './state/store';
import { BoardProvider } from './state/useBoard';
import './styles.css';

// One id per browser tab: the server stamps it on events, so the activity log can tell "you" from "another user".
const clientId = crypto.randomUUID();
const store = createBoardStore({ api: createHttpApi(clientId), clientId });
connectLive(store);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BoardProvider store={store}>
      <App />
    </BoardProvider>
  </StrictMode>,
);
