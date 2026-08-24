export type PortalImageViewState = 'both' | 'street-only' | 'satellite-only' | 'neither';

export type PortalImageVisibility = {
  state: PortalImageViewState;
  street: boolean;
  satellite: boolean;
};

export function resolvePortalImageVisibility(
  street: boolean,
  satellite: boolean,
): PortalImageVisibility {
  return {
    state: street ? (satellite ? 'both' : 'street-only') : satellite ? 'satellite-only' : 'neither',
    street,
    satellite,
  };
}
