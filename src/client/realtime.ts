import React from 'react';

export function useSocket<T>(event: string, onPayload: (payload: T) => void) {
  React.useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/socket`);
    socket.addEventListener('message', (messageEvent) => {
      const data = JSON.parse(messageEvent.data) as { event: string; payload: T };
      if (data.event === event) onPayload(data.payload);
    });

    return () => {
      socket.close();
    };
  }, [event, onPayload]);
}
