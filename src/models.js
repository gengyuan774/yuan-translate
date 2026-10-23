// Used by the server, request builder and summary cache identity.
export const TEXT_MODEL='gpt-4.1-mini';
export const TRANSCRIPTION_MODEL='gpt-transcribe';

export const TRANSLATION_MODES={
 accurate:{label:'准确模式',model:TRANSCRIPTION_MODEL,maxTurnSamples:192000,silenceSamples:28800,mergeWait:6000},
 // Keep the same recognizer; shorten waiting without aggressively splitting speech.
 fast:{label:'快速翻译',model:TRANSCRIPTION_MODEL,maxTurnSamples:144000,silenceSamples:21600,mergeWait:3000}
};
export const validTranslationMode=value=>typeof value==='string'&&Object.hasOwn(TRANSLATION_MODES,value);
export const translationMode=value=>TRANSLATION_MODES[validTranslationMode(value)?value:'accurate'];
