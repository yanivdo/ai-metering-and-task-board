import { ActivityLog } from './components/ActivityLog';
import { AssigneeView } from './components/AssigneeView';
import { ConnectionBadge } from './components/ConnectionBadge';
import { SummaryPanel } from './components/SummaryPanel';
import { TaskEditor } from './components/TaskEditor';
import { TaskList } from './components/TaskList';

/** Five views of the same store. None of them passes data to another: each reads the store directly. */
export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Team Task Board</h1>
        <ConnectionBadge />
      </header>
      <main className="layout">
        <TaskList />
        <TaskEditor />
        <div className="side">
          <SummaryPanel />
          <AssigneeView />
        </div>
        <ActivityLog />
      </main>
    </div>
  );
}
