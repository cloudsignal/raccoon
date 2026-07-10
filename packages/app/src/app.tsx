import { useChat } from './transport/context.js';
import { ChatScreen } from './components/chat-screen.js';
import { SetupScreen } from './components/setup-screen.js';

export function App() {
  const { phase } = useChat();
  if (phase === 'loading') {
    return <div className="flex h-full items-center justify-center text-ink-faint">Loading</div>;
  }
  if (phase === 'setup') return <SetupScreen />;
  return <ChatScreen />;
}
