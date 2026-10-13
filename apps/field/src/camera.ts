/**
 * Taking a photo for a field record (FLD-07, PHO-06, FLD-14): the phone's
 * camera (or a file on the web build, which uses the browser's camera
 * picker), reduced to at most 1,600 pixels wide and re-encoded as JPEG. The
 * re-encode leaves the camera's metadata behind; the place and time travel
 * beside the photo instead (and the server strips metadata again on its
 * side). The bytes go straight into the encrypted store, never the gallery.
 */
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export interface Shot {
  data: string;
  contentType: 'image/jpeg';
  bytes: number;
}

const MAX_WIDTH = 1600;

export async function takePhoto(fromLibrary = false): Promise<Shot | 'denied' | null> {
  if (!fromLibrary) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return 'denied';
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 0.8,
    exif: false,
    base64: false,
  };
  const picked = fromLibrary
    ? await ImagePicker.launchImageLibraryAsync(options)
    : await ImagePicker.launchCameraAsync(options);
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return null;
  const ctx = ImageManipulator.manipulate(asset.uri);
  if (asset.width > MAX_WIDTH) ctx.resize({ width: MAX_WIDTH });
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ base64: true, compress: 0.7, format: SaveFormat.JPEG });
  const data = saved.base64 ?? '';
  if (!data) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return { data, contentType: 'image/jpeg', bytes: (data.length * 3) / 4 - padding };
}
