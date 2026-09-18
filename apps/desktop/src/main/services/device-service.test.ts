import { describe, expect, it } from 'vitest';
import {
  humaniseRuntime,
  matchWindowSource,
  parseAndroidDevices,
  parseSimctlList,
  pickDevice,
  sortDevices,
} from './device-service';

const simctl = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'A1', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'A2', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      { udid: 'A3', name: 'iPad Air 13-inch (M3)', state: 'Shutdown', isAvailable: true },
      { udid: 'A4', name: 'iPhone SE (3rd generation)', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [
      { udid: 'W1', name: 'Apple Watch Ultra 3 (49mm)', state: 'Shutdown', isAvailable: true },
    ],
  },
});

describe('parseSimctlList', () => {
  it('lists available simulators with a readable runtime, booted first', () => {
    const list = parseSimctlList(simctl);
    expect(list.map((d) => [d.name, d.state, d.runtime])).toEqual([
      ['iPhone 17', 'booted', 'iOS 26.5'],
      ['Apple Watch Ultra 3 (49mm)', 'shutdown', 'watchOS 12.0'],
      ['iPad Air 13-inch (M3)', 'shutdown', 'iOS 26.5'],
      ['iPhone 17 Pro', 'shutdown', 'iOS 26.5'],
    ]);
    expect(list.every((d) => d.platform === 'ios')).toBe(true);
  });

  it('tolerates garbage', () => {
    expect(parseSimctlList('not json')).toEqual([]);
    expect(parseSimctlList('{"devices":{"x":"nope"}}')).toEqual([]);
  });

  it('humanises runtime ids', () => {
    expect(humaniseRuntime('com.apple.CoreSimulator.SimRuntime.iOS-18-2')).toBe('iOS 18.2');
    expect(humaniseRuntime('com.apple.CoreSimulator.SimRuntime.iOS-26-5-1')).toBe('iOS 26.5.1');
    expect(humaniseRuntime('iOS 17')).toBe('iOS 17');
    expect(humaniseRuntime('')).toBeNull();
  });
});

describe('parseAndroidDevices', () => {
  it('lists AVDs and running emulators, running first', () => {
    const list = parseAndroidDevices(
      'INFO    | Storing crashdata in: /tmp\nPixel_8_API_35\nPixel_Tablet_API_34\n',
      'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64 model:sdk_gphone64_arm64\n',
    );
    expect(list.map((d) => [d.id, d.name, d.state])).toEqual([
      ['emulator-5554', 'emulator-5554', 'booted'],
      ['Pixel_8_API_35', 'Pixel 8 API 35', 'shutdown'],
      ['Pixel_Tablet_API_34', 'Pixel Tablet API 34', 'shutdown'],
    ]);
  });
});

describe('pickDevice', () => {
  const list = sortDevices(parseSimctlList(simctl));
  it('prefers the asked name, then the remembered one, then a booted device, then an iPhone', () => {
    expect(pickDevice(list, 'iPhone 17 Pro', null)?.id).toBe('A1');
    expect(pickDevice(list, 'ipad', null)?.id).toBe('A3'); // case-insensitive prefix
    expect(pickDevice(list, null, 'iPhone 17 Pro')?.id).toBe('A1');
    expect(pickDevice(list, null, null)?.id).toBe('A2'); // booted
    const shut = list.map((d) => ({ ...d, state: 'shutdown' as const }));
    expect(pickDevice(shut, null, null)?.name).toMatch(/^iPhone/);
    expect(pickDevice([], null, null)).toBeNull();
  });
});

describe('matchWindowSource', () => {
  const sources = [
    { id: 'window:1:0', name: 'Styx' },
    { id: 'window:2:0', name: 'iPhone 17 Pro – iOS 26.5' },
    { id: 'window:3:0', name: 'iPhone 17 – iOS 26.5' },
    { id: 'window:4:0', name: 'Android Emulator - Pixel_8_API_35:5554' },
  ];
  it('finds the simulator window by device name and the emulator window by AVD', () => {
    expect(matchWindowSource(sources, { platform: 'ios', name: 'iPhone 17', id: 'A2' })?.id).toBe(
      'window:3:0',
    );
    expect(matchWindowSource(sources, { platform: 'ios', name: 'iPhone 17 Pro', id: 'A1' })?.id).toBe(
      'window:2:0',
    );
    expect(
      matchWindowSource(sources, { platform: 'android', name: 'Pixel 8 API 35', id: 'Pixel_8_API_35' })?.id,
    ).toBe('window:4:0');
    expect(matchWindowSource(sources, { platform: 'ios', name: 'iPad Air', id: 'A3' })).toBeNull();
  });
});
