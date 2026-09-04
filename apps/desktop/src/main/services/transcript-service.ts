import { newId, type AskId, type MessagePayload, type SessionId, type TranscriptMessage } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';

/** Appends transcript rows and publishes `transcript.append` deltas. */
export class TranscriptService {
  constructor(
    private readonly repos: Repos,
    private readonly publisher: Publisher,
    private readonly clock: Clock,
  ) {}

  append(
    sessionId: SessionId,
    body: string,
    payload: MessagePayload,
    askId: AskId | null = null,
  ): TranscriptMessage {
    const message: TranscriptMessage = {
      id: newId<'MessageId'>(),
      sessionId,
      seq: this.repos.transcripts.nextSeq(sessionId),
      body,
      payload,
      askId,
      createdAt: this.clock.now(),
    };
    this.repos.transcripts.upsert(message);
    this.publisher.transcriptAppend(sessionId, [message]);
    return message;
  }

  system(sessionId: SessionId, body: string): TranscriptMessage {
    return this.append(sessionId, body, { kind: 'system' });
  }

  user(sessionId: SessionId, body: string): TranscriptMessage {
    return this.append(sessionId, body, { kind: 'user' });
  }

  patch(sessionId: SessionId, messageId: string, body: string): void {
    this.repos.transcripts.patchBody(messageId, body);
    this.publisher.transcriptPatch(sessionId, messageId, body);
  }
}
