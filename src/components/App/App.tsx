import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { ROUTES } from '../../constants';

const SessionsPage = React.lazy(() => import('../../pages/SessionsPage'));
const ReplayPage = React.lazy(() => import('../../pages/ReplayPage'));
const SessionRedirectPage = React.lazy(() => import('../../pages/SessionRedirectPage'));
const AgentsPage = React.lazy(() => import('../../pages/AgentsPage'));
const AgentDayPage = React.lazy(() => import('../../pages/AgentDayPage'));

function App(_props: AppRootProps) {
  return (
    <Routes>
      <Route path={ROUTES.Sessions} element={<SessionsPage />} />
      <Route path={`${ROUTES.App}/:appName/session/:sessionId`} element={<ReplayPage />} />
      <Route path={ROUTES.Agents} element={<AgentsPage />} />
      <Route path={`${ROUTES.Agents}/:appName/:userId`} element={<AgentDayPage />} />
      {/* For links that only know the session id (e.g. a Loki derived field). */}
      <Route path="session/:sessionId" element={<SessionRedirectPage />} />
      <Route path="*" element={<Navigate to={ROUTES.Sessions} replace />} />
    </Routes>
  );
}

export default App;
