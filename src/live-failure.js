// Detach before closing: onclose must not overwrite the actual startup error.
export function closeFailedConnection(connection){
 if(!connection)return;
 connection.onclose=null;connection.onmessage=null;connection.onerror=null;
 connection.close();
}
