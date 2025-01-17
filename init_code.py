# This defines the serialization/deserialization code for keras models when used
# in deepforge

import os
import time
import tarfile
import shutil

import tensorflow.keras as keras

import deepforge


def dump_model(model, outfile):
    # Create the tmp directory
    tmp_dir = outfile.name + '-tmp-' + str(time.time())
    model.save(tmp_dir)

    with tarfile.open(outfile.name, 'w:gz') as tar:
        tar.add(tmp_dir, arcname='SavedModel')

    shutil.rmtree(tmp_dir)


def load_model(infile):
    tmp_dir = infile.name + '-tmp-' + str(time.time())
    os.makedirs(tmp_dir)

    with tarfile.open(infile.name) as tar:
        def is_within_directory(directory, target):
            
            abs_directory = os.path.abspath(directory)
            abs_target = os.path.abspath(target)
        
            prefix = os.path.commonprefix([abs_directory, abs_target])
            
            return prefix == abs_directory
        
        def safe_extract(tar, path=".", members=None, *, numeric_owner=False):
        
            for member in tar.getmembers():
                member_path = os.path.join(path, member.name)
                if not is_within_directory(path, member_path):
                    raise Exception("Attempted Path Traversal in Tar File")
        
            tar.extractall(path, members, numeric_owner=numeric_owner) 
            
        
        safe_extract(tar, path=tmp_dir)

    model = keras.models.load_model(os.path.join(tmp_dir, 'SavedModel'))

    shutil.rmtree(tmp_dir)

    return model


for subclass in keras.Model.__subclasses__():
    deepforge.serialization.register(subclass, dump_model, load_model)
