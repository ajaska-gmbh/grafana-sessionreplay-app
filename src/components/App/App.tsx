import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { ROUTES } from '../../constants';

const SessionsPage = React.lazy(() => import('../../pages/SessionsPage'));
const ReplayPage = React.lazy(() => import('../../pages/ReplayPage'));

function App(_props: AppRootProps) {
  return (
    <Routes>
      <Route path={ROUTES.Sessions} element={<SessionsPage />} />
      <Route path={`${ROUTES.App}/:appName/session/:sessionId`} element={<ReplayPage />} />
      <Route path="*" element={<Navigate to={ROUTES.Sessions} replace />} />
    </Routes>
  );
}

export default App;
