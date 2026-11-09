import {useCallback, useMemo, useState} from 'react';
import type {Developer} from '../../shared/types.ts';
import {Join, ProjectScreen} from './Entry.tsx';
import {Shell} from './Shell.tsx';
import {AlignContext, buildLookup, readIdentity, useConnection, writeIdentity} from './state.ts';

export function App() {
  const [developerId, setDeveloperId] = useState(readIdentity);
  const {snapshot, setSnapshot, online, epoch, subscribe} = useConnection(developerId);
  const lookup = useMemo(() => (snapshot ? buildLookup(snapshot) : null), [snapshot]);

  const identify = useCallback(
    (dev: Developer) => {
      writeIdentity(dev.id);
      setDeveloperId(dev.id);
      // The broadcast naming this developer may still be on its way.
      setSnapshot((s) => (s && !s.developers.some((d) => d.id === dev.id) ? {...s, developers: [...s.developers, dev]} : s));
    },
    [setSnapshot],
  );

  if (!snapshot || !lookup) return null;
  const me = lookup.developers.get(developerId);
  if (!me) return <Join onJoin={identify} />;
  if (!snapshot.project) return <ProjectScreen />;

  return (
    <AlignContext value={{snapshot, me, lookup, online, epoch, subscribe, identify}}>
      <Shell />
    </AlignContext>
  );
}
