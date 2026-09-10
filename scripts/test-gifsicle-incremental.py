import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from PIL import Image

spec=importlib.util.spec_from_file_location("gifsicle_pilot",Path(__file__).with_name("benchmark-gifsicle-incremental.py"))
pilot=importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class ContractTests(unittest.TestCase):
    def test_merge_only_preserves_identical_display_time(self):
        self.assertEqual(pilot.timed_frames(["a","a","b"],[5,7,8]),pilot.timed_frames(["a","b"],[12,8]))
        self.assertNotEqual(pilot.timed_frames(["a","b"],[12,8]),pilot.timed_frames(["a","b"],[8,12]))

    def test_short_delays_keep_frame_structure(self):
        self.assertNotEqual(pilot.timed_frames(["a","a"],[1,1]),pilot.timed_frames(["a"],[2]))
        self.assertNotEqual(pilot.timed_frames(["a","a"],[0,0]),pilot.timed_frames(["a"],[0]))

    def test_hidden_rgb_does_not_change_visible_contract(self):
        self.assertEqual(pilot.visible_hash(bytes([1,2,3,0])),pilot.visible_hash(bytes([8,9,10,0])))
        self.assertNotEqual(pilot.visible_hash(bytes([1,2,3,255])),pilot.visible_hash(bytes([8,9,10,255])))

    def test_loop_and_canvas_are_required(self):
        base={"width":4,"height":4,"loop":0,"timeline":[("a",10)]}
        for change in [{"loop":None},{"loop":2},{"width":8},{"timeline":[("b",10)]}]:
            self.assertFalse(pilot.same_metadata_and_pillow(base,{**base,**change}))

    @unittest.skipUnless(os.environ.get("GIFP_TEST_FFMPEG") and os.environ.get("GIFP_TEST_GIFSICLE"),"requires local tools")
    def test_real_loop_variants_and_pixel_corruption(self):
        with tempfile.TemporaryDirectory(prefix="gifp-gifsicle-contract-") as folder:
            root=Path(folder)
            frames=[Image.new("RGBA",(16,16),color) for color in [(200,10,20,255),(20,150,220,255)]]
            for index,loop in enumerate([None,0,1,3]):
                source=root/f"source-{index}.gif"; candidate=root/f"candidate-{index}.gif"
                args={} if loop is None else {"loop":loop}
                frames[0].save(source,save_all=True,append_images=frames[1:],duration=[80,120],disposal=2,**args)
                subprocess.run([os.environ['GIFP_TEST_GIFSICLE'],"-O3","--no-ignore-errors","-o",str(candidate),str(source)],check=True,capture_output=True,timeout=30)
                result=pilot.inspect_pair(Path(os.environ['GIFP_TEST_FFMPEG']),source,candidate)
                self.assertTrue(result['verified_equal'],(loop,result))
            altered=root/'altered.gif'
            frames[0].save(altered,save_all=True,append_images=[Image.new('RGBA',(16,16),(1,2,3,255))],duration=[80,120],disposal=2,loop=3)
            self.assertFalse(pilot.inspect_pair(Path(os.environ['GIFP_TEST_FFMPEG']),source,altered)['verified_equal'])
            for index,loop in enumerate([None,0,1,3]):
                source=root/f"single-{index}.gif"; candidate=root/f"single-opt-{index}.gif"
                args={} if loop is None else {"loop":loop}
                frames[0].save(source,duration=80,**args)
                subprocess.run([os.environ['GIFP_TEST_GIFSICLE'],"-O3","--no-ignore-errors","-o",str(candidate),str(source)],check=True,capture_output=True,timeout=30)
                self.assertTrue(pilot.inspect_pair(Path(os.environ['GIFP_TEST_FFMPEG']),source,candidate)['verified_equal'])


if __name__ == '__main__':
    unittest.main()
