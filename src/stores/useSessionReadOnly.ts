import {useSessionStore} from './useSessionStore';
export function useSessionReadOnly(sessionId?:string) {
  return useSessionStore(state=>state.sessions.find(session=>session.id===sessionId)?.readOnly ?? true);
}
