import { CrossingScroller, type CrossingStep } from './CrossingScroller';
import { Section } from './Section';

const steps: readonly CrossingStep[] = [
  {
    title: 'The agent tries something real',
    body: 'Say it runs a deploy, or wants to change your live database. Styx catches the request before it goes anywhere. The agent never sees a password or a key, so there is nothing for it to leak or misuse.',
  },
  {
    title: 'It waits for you',
    body: 'The agent pauses. You see the request wherever you happen to be: in its chat, on the board, in your inbox, as a notification, as a badge on the dock. Answer in any one place and it’s answered everywhere.',
  },
  {
    title: 'You decide how much to allow',
    body: 'Just read, or also write? This once, for an hour, or until the agent is done? Anything that touches production asks for your fingerprint or face before it goes through.',
  },
  {
    title: 'The agent gets a temporary pass',
    body: 'It works only for what you allowed, only for that agent, and only for as long as you said. When the time is up, or the agent finishes, or you change your mind, the pass is gone. Nothing permanent is ever handed over.',
  },
  {
    title: 'It’s written down',
    body: 'Who asked, what they got, for how long, and what they did with it. The record can’t be edited or deleted, by anyone, ever. Taking a pass away adds a line; it never removes one.',
  },
];

export const GrantFlow = () => (
  <Section
    id="access"
    title="What happens at the crossing"
    lede="Agents build freely on your side of the river. To deploy, or touch live data, they have to cross, and nothing crosses without you. It asks, you decide, it gets a temporary pass, and the record keeps the receipt."
  >
    <CrossingScroller steps={steps} />
  </Section>
);
