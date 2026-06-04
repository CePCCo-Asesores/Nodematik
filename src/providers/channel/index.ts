import type { ChannelProvider } from './types';
import { MetaCloudProvider } from './meta-cloud';

const registry = new Map<string, ChannelProvider>();

registry.set('meta_cloud', new MetaCloudProvider());
registry.set('embedded_signup', new MetaCloudProvider()); // uses the same Cloud API

export function getChannelProvider(providerName: string): ChannelProvider {
  const provider = registry.get(providerName);
  if (!provider) throw new Error(`Unknown channel provider: ${providerName}`);
  return provider;
}

export type { ChannelProvider };
