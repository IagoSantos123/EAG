// Contexto do painel: usuário, chamadas autenticadas e eventos em tempo real.
import { createContext, useContext, useEffect, useRef } from 'react';

export const AdminContext = createContext(null);
export const useAdmin = () => useContext(AdminContext);

// Recarrega dados quando chegam eventos em tempo real (com pequeno atraso para agrupar rajadas).
export function useLiveRefresh(callback, types = ['order', 'payment', 'cash']) {
  const { onEvent } = useAdmin();
  const saved = useRef(callback);
  saved.current = callback;
  const typesKey = types.join(',');
  useEffect(() => {
    let timer;
    return onEvent((event) => {
      if (event.type !== 'tick' && !typesKey.split(',').includes(event.type)) return;
      clearTimeout(timer);
      timer = setTimeout(() => saved.current(event), 350);
    });
  }, [onEvent, typesKey]);
}
