import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DevApp from './DevApp';
import Studio from './studio/Studio';
import './styles.css';

// "#/dev" is the developer console; everything else is the user-facing studio.
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return hash.startsWith('#/dev') ? <DevApp /> : <Studio />;
}

createRoot(document.getElementById('root')!).render(<Root />);
