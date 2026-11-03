import React, { useEffect, useState } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder } from '@grafana/ui';
import { Navigate, useParams } from 'react-router-dom';
import { useSettings } from '../hooks/useSettings';
import { replayUrl } from '../lib/format';
import { fetchSessions } from '../lib/sessionQueries';
import { sessionRange } from '../lib/sessions';

const LOOKBACKS_MS = [24 * 3600_000, 14 * 24 * 3600_000];

/**
 * `/session/<session_id>`: for links that only know the session id, such as a
 * Loki derived field on `session_id=…`. Finds the session's app from its
 * replay start markers and redirects to the full viewer.
 */
function SessionRedirectPage() {
  const { sessionId = '' } = useParams();
  const { lokiUid } = useSettings();
  const [target, setTarget] = useState<string | null>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = Date.now();
      for (const lookback of LOOKBACKS_MS) {
        const { sessions } = await fetchSessions(lokiUid, [], now - lookback, now, 1000, sessionId);
        const session = sessions.find((candidate) => candidate.sessionId === sessionId);
        if (session) {
          return replayUrl(session.appName, sessionId, sessionRange(session, now));
        }
      }
      return null;
    })()
      .catch(() => null)
      .then((url) => {
        if (!cancelled) {
          setTarget(url);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lokiUid, sessionId]);

  if (target) {
    return <Navigate to={target} replace />;
  }

  return (
    <PluginPage pageNav={{ text: `Session ${sessionId}` }}>
      {target === null ? (
        <Alert severity="info" title="No recording found">
          Session {sessionId} has no session replay in the retained data (14 days).
        </Alert>
      ) : (
        <LoadingPlaceholder text="Looking up the session…" />
      )}
    </PluginPage>
  );
}

export default SessionRedirectPage;
