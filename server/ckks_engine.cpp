#include "seal/seal.h"
#include <emscripten/bind.h>
#include <string>
#include <vector>
#include <sstream>
#include <algorithm>

using namespace std;
using namespace seal;
using namespace emscripten;

// --- BASE64 HELPERS ---
static const string base64_chars = 
             "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
             "abcdefghijklmnopqrstuvwxyz"
             "0123456789+/";

string base64_encode(const string &in) {
    string out;
    int val = 0, valb = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        valb += 8;
        while (valb >= 0) {
            out.push_back(base64_chars[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6) out.push_back(base64_chars[((val << 8) >> (valb + 8)) & 0x3F]);
    while (out.size() % 4) out.push_back('=');
    return out;
}

string base64_decode(const string &in) {
    string out;
    vector<int> T(256, -1);
    for (int i = 0; i < 64; i++) T[base64_chars[i]] = i;
    int val = 0, valb = -8;
    for (unsigned char c : in) {
        if (T[c] == -1) break;
        val = (val << 6) + T[c];
        valb += 6;
        if (valb >= 0) {
            out.push_back(char((val >> valb) & 0xFF));
            valb -= 8;
        }
    }
    return out;
}

class CKKSEngine {
public:
    CKKSEngine(int poly_modulus_degree) {
        EncryptionParameters parms(scheme_type::ckks);
        parms.set_poly_modulus_degree(poly_modulus_degree);
        parms.set_coeff_modulus(CoeffModulus::Create(poly_modulus_degree, { 60, 40, 40, 60 }));
        context = make_shared<SEALContext>(parms);
        scale = pow(2.0, 40);
    }

    val generateKeys() {
        KeyGenerator keygen(*context);
        auto sk = keygen.secret_key();
        PublicKey pk;
        keygen.create_public_key(pk);
        RelinKeys rk;
        keygen.create_relin_keys(rk);

        stringstream ss_sk, ss_pk, ss_rk;
        sk.save(ss_sk);
        pk.save(ss_pk);
        rk.save(ss_rk);

        val result = val::object();
        result.set("secretKey", base64_encode(ss_sk.str()));
        result.set("publicKey", base64_encode(ss_pk.str()));
        result.set("relinKeys", base64_encode(ss_rk.str()));
        return result;
    }

    string encrypt(const val& jsInput, const string& publicKeyB64) {
        vector<double> input = vecFromJSArray<double>(jsInput);
        PublicKey pk;
        string decodedKey = base64_decode(publicKeyB64);
        stringstream ss_pk(decodedKey);
        pk.load(*context, ss_pk);

        Encryptor encryptor(*context, pk);
        CKKSEncoder encoder(*context);
        Plaintext plain;
        encoder.encode(input, scale, plain);
        Ciphertext encrypted;
        encryptor.encrypt(plain, encrypted);

        stringstream ss_data;
        encrypted.save(ss_data);
        return base64_encode(ss_data.str());
    }

    val decrypt(const string& cipherTextB64, const string& secretKeyB64) {
        SecretKey sk;
        string decodedKey = base64_decode(secretKeyB64);
        stringstream ss_sk(decodedKey);
        sk.load(*context, ss_sk);

        Decryptor decryptor(*context, sk);
        CKKSEncoder encoder(*context);
        Ciphertext encrypted;
        string decodedCipher = base64_decode(cipherTextB64);
        stringstream ss_data(decodedCipher);
        encrypted.load(*context, ss_data);

        Plaintext plain;
        decryptor.decrypt(encrypted, plain);
        vector<double> result;
        encoder.decode(plain, result);
        
        val jsResult = val::array();
        for(double d : result) jsResult.call<void>("push", d);
        return jsResult;
    }

    string computeDotProduct(const string& cipherA_B64, const string& cipherB_B64, const string& relinKeysB64) {
        RelinKeys rk;
        string decodedKeys = base64_decode(relinKeysB64);
        stringstream ss_rk(decodedKeys);
        rk.load(*context, ss_rk);

        Ciphertext cA, cB;
        stringstream ss_A(base64_decode(cipherA_B64));
        stringstream ss_B(base64_decode(cipherB_B64));
        cA.load(*context, ss_A);
        cB.load(*context, ss_B);

        Evaluator evaluator(*context);
        evaluator.multiply_inplace(cA, cB);
        evaluator.relinearize_inplace(cA, rk);
        evaluator.rescale_to_next_inplace(cA);

        stringstream ss_out;
        cA.save(ss_out);
        return base64_encode(ss_out.str());
    }

private:
    shared_ptr<SEALContext> context;
    double scale;
};

EMSCRIPTEN_BINDINGS(ckks_module) {
    class_<CKKSEngine>("CKKSEngine")
        .constructor<int>()
        .function("generateKeys", &CKKSEngine::generateKeys)
        .function("encrypt", &CKKSEngine::encrypt)
        .function("decrypt", &CKKSEngine::decrypt)
        .function("computeDotProduct", &CKKSEngine::computeDotProduct);
}